#!/usr/bin/env bash
set -euo pipefail

REPO="foxhello-ai/codex-manage"
VERSION="latest"
LOCAL_PACKAGE=""
LOCAL_CHECKSUM=""
SERVICE_USER="${SUDO_USER:-deploy}"
SERVICE_GROUP=""
INSTALL_DIR="/opt/codex-manage"
ENV_FILE="/etc/codex-manage/codex-manage.env"
SERVICE_NAME="codex-manage"
HOST="127.0.0.1"
PORT="4310"
START_SERVICE="1"

usage() {
  cat <<'EOF'
Install Codex Manage runtime package from GitHub Releases or a local tarball.

Usage:
  install-runtime.sh [options]

Options:
  --repo OWNER/REPO       GitHub repository. Default: foxhello-ai/codex-manage
  --version VERSION      Release version, for example 1.0.1 or v1.0.1. Default: latest
  --package FILE         Local .tgz package or GitHub Actions artifact .zip. Skips GitHub download
  --checksum FILE        Optional sha256 file for local .tgz. Default: FILE.sha256 when present
  --user USER            Linux user that owns the real Codex sessions. Default: $SUDO_USER or deploy
  --group GROUP          Linux group for installed files. Default: user's primary group
  --install-dir DIR      Install directory. Default: /opt/codex-manage
  --env-file FILE        Environment file. Default: /etc/codex-manage/codex-manage.env
  --service-name NAME    systemd service name. Default: codex-manage
  --host HOST            Web listen host. Default: 127.0.0.1
  --port PORT            Web listen port. Default: 4310
  --no-start             Install files and service, but do not start/restart systemd service
  -h, --help             Show this help

Environment:
  GITHUB_TOKEN or GH_TOKEN can be set for higher GitHub download rate limits.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --package)
      LOCAL_PACKAGE="$2"
      shift 2
      ;;
    --checksum)
      LOCAL_CHECKSUM="$2"
      shift 2
      ;;
    --user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --group)
      SERVICE_GROUP="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --host)
      HOST="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --no-start)
      START_SERVICE="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This installer must run as root. Use sudo." >&2
  exit 1
fi

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

need_command tar
need_command systemctl

if [[ -z "$LOCAL_PACKAGE" ]]; then
  need_command curl
  need_command sha256sum
elif [[ -n "$LOCAL_CHECKSUM" || -f "${LOCAL_PACKAGE}.sha256" ]]; then
  need_command sha256sum
fi

if [[ -n "$LOCAL_PACKAGE" && "$LOCAL_PACKAGE" == *.zip ]]; then
  need_command unzip
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Linux user not found: $SERVICE_USER" >&2
  echo "Create/login with the same user that owns the real Codex sessions, then rerun with --user." >&2
  exit 1
fi

if [[ -z "$SERVICE_GROUP" ]]; then
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
fi

USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
if [[ -z "$USER_HOME" || ! -d "$USER_HOME" ]]; then
  echo "Cannot determine home directory for user: $SERVICE_USER" >&2
  exit 1
fi

run_as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    su - "$SERVICE_USER" -c "$(printf '%q ' "$@")"
  fi
}

detect_codex_path() {
  run_as_service_user bash -lc 'command -v codex' 2>/dev/null || true
}

detect_node_path() {
  local node_path
  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -n "$node_path" ]]; then
    printf '%s\n' "$node_path"
    return
  fi

  node_path="$(run_as_service_user bash -lc 'command -v node' 2>/dev/null || true)"
  if [[ -n "$node_path" ]]; then
    printf '%s\n' "$node_path"
    return
  fi

  for node_path in /usr/local/bin/node /usr/bin/node /bin/node; do
    if [[ -x "$node_path" ]]; then
      printf '%s\n' "$node_path"
      return
    fi
  done
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n'
    printf '\n'
  fi
}

curl_download() {
  local url="$1"
  local output="$2"
  local token
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  local args=(-fsSL --retry 3 --retry-delay 2)
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  curl "${args[@]}" "$url" -o "$output"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PACKAGE_FILE="$TMP_DIR/codex-manage-runtime.tgz"
CHECKSUM_FILE="$TMP_DIR/codex-manage-runtime.tgz.sha256"

if [[ -n "$LOCAL_PACKAGE" ]]; then
  if [[ ! -f "$LOCAL_PACKAGE" ]]; then
    echo "Local package not found: $LOCAL_PACKAGE" >&2
    exit 1
  fi

  echo "Using local Codex Manage runtime package: $LOCAL_PACKAGE"

  if [[ "$LOCAL_PACKAGE" == *.zip ]]; then
    ARTIFACT_DIR="$TMP_DIR/artifact"
    mkdir -p "$ARTIFACT_DIR"
    unzip -q "$LOCAL_PACKAGE" -d "$ARTIFACT_DIR"

    ARTIFACT_PACKAGE="$(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name 'codex-manage-runtime.tgz' -print -quit)"
    if [[ -z "$ARTIFACT_PACKAGE" ]]; then
      echo "Invalid Actions artifact zip: missing codex-manage-runtime.tgz" >&2
      exit 1
    fi
    cp "$ARTIFACT_PACKAGE" "$PACKAGE_FILE"

    if [[ -z "$LOCAL_CHECKSUM" ]]; then
      ARTIFACT_CHECKSUM="$(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name 'codex-manage-runtime.tgz.sha256' -print -quit)"
      if [[ -n "$ARTIFACT_CHECKSUM" ]]; then
        LOCAL_CHECKSUM="$ARTIFACT_CHECKSUM"
      fi
    fi
  else
    if [[ -z "$LOCAL_CHECKSUM" && -f "${LOCAL_PACKAGE}.sha256" ]]; then
      LOCAL_CHECKSUM="${LOCAL_PACKAGE}.sha256"
    fi
    cp "$LOCAL_PACKAGE" "$PACKAGE_FILE"
  fi

  if [[ -n "$LOCAL_CHECKSUM" ]]; then
    need_command sha256sum
    if [[ ! -f "$LOCAL_CHECKSUM" ]]; then
      echo "Local checksum file not found: $LOCAL_CHECKSUM" >&2
      exit 1
    fi
    cp "$LOCAL_CHECKSUM" "$CHECKSUM_FILE"
    (
      cd "$TMP_DIR"
      sha256sum -c codex-manage-runtime.tgz.sha256
    )
  else
    echo "No checksum file provided or found at ${LOCAL_PACKAGE}.sha256; skipping checksum verification."
  fi
else
  if [[ "$VERSION" == "latest" ]]; then
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/latest/download"
  else
    VERSION="${VERSION#v}"
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
  fi

  echo "Downloading Codex Manage runtime from $DOWNLOAD_BASE"
  curl_download "$DOWNLOAD_BASE/codex-manage-runtime.tgz" "$PACKAGE_FILE"
  curl_download "$DOWNLOAD_BASE/codex-manage-runtime.tgz.sha256" "$CHECKSUM_FILE"

  (
    cd "$TMP_DIR"
    sha256sum -c codex-manage-runtime.tgz.sha256
  )
fi

EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_DIR"

BUILD_INFO="$EXTRACT_DIR/codex-manage/build-info.txt"
if [[ ! -f "$BUILD_INFO" ]]; then
  echo "Invalid runtime package: missing build-info.txt" >&2
  exit 1
fi

PACKAGE_VERSION="$(sed -n 's/^version=//p' "$BUILD_INFO" | head -1)"
SOURCE_COMMIT="$(sed -n 's/^source_commit=//p' "$BUILD_INFO" | head -1)"
SOURCE_COMMIT_SHORT="${SOURCE_COMMIT:0:12}"
if [[ -z "$PACKAGE_VERSION" ]]; then
  PACKAGE_VERSION="${VERSION:-unknown}"
fi
if [[ -z "$SOURCE_COMMIT_SHORT" ]]; then
  SOURCE_COMMIT_SHORT="unknown"
fi

RELEASE_NAME="${PACKAGE_VERSION}-${SOURCE_COMMIT_SHORT}"
RELEASES_DIR="$INSTALL_DIR/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_NAME"
CURRENT_LINK="$INSTALL_DIR/current"

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$RELEASES_DIR"
rm -rf "$RELEASE_DIR"
mv "$EXTRACT_DIR/codex-manage" "$RELEASE_DIR"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
chown -h "$SERVICE_USER:$SERVICE_GROUP" "$CURRENT_LINK"

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$USER_HOME/.codex-manage"
install -d -m 755 "$(dirname "$ENV_FILE")"

CODEX_PATH="$(detect_codex_path)"
if [[ -z "$CODEX_PATH" ]]; then
  CODEX_PATH="codex"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  WEB_PASSWORD="$(generate_secret)"
  SESSION_SECRET="$(generate_secret)"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
CODEX_WEB_HOST=$HOST
CODEX_WEB_PORT=$PORT
CODEX_WEB_PASSWORD=$WEB_PASSWORD
CODEX_WEB_SESSION_SECRET=$SESSION_SECRET
CODEX_CLI_PATH=$CODEX_PATH
CODEX_SESSIONS_DIR=$USER_HOME/.codex/sessions
CODEX_MANAGE_METADATA_FILE=$USER_HOME/.codex-manage/session-metadata.json
EOF
  echo "Created $ENV_FILE with generated credentials."
else
  echo "Keeping existing $ENV_FILE."
fi

NODE_PATH="$(detect_node_path)"
if [[ -z "$NODE_PATH" ]]; then
  echo "Required command not found: node" >&2
  echo "Install Node.js for $SERVICE_USER, or make node available in PATH before rerunning." >&2
  exit 1
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Codex Manage Web
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$CURRENT_LINK
Environment=HOME=$USER_HOME
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_PATH dist/server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

ln -sfn "$ENV_FILE" "$INSTALL_DIR/env"
ln -sfn "$SERVICE_FILE" "$INSTALL_DIR/service"
ln -sfn "$CURRENT_LINK/build-info.txt" "$INSTALL_DIR/build-info.txt"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

if [[ "$START_SERVICE" == "1" ]]; then
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --full status "$SERVICE_NAME" || true
else
  echo "Service installed but not started because --no-start was set."
fi

cat <<EOF

Installed Codex Manage:
  release:      $RELEASE_NAME
  current:      $CURRENT_LINK
  service:      $SERVICE_NAME
  environment:  $ENV_FILE
  build info:   $CURRENT_LINK/build-info.txt

Operational shortcuts:
  env link:     $INSTALL_DIR/env
  service link: $INSTALL_DIR/service
  build link:   $INSTALL_DIR/build-info.txt

Check health:
  curl http://$HOST:$PORT/api/health

EOF
