#!/usr/bin/env bash
set -euo pipefail

REPO="foxhello-ai/codex-manage"
VERSION="latest"
LOCAL_PACKAGE=""
LOCAL_CHECKSUM=""
SERVICE_USER=""
SERVICE_GROUP=""
INSTALL_DIR=""
ENV_FILE=""
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
  --user USER            Session owner. Linux: sudo invoking user; macOS: current user only
  --group GROUP          Linux group for installed files. Default: user's primary group
  --install-dir DIR      Linux: /opt/codex-manage; macOS: ~/Library/Application Support/Codex Manage
  --env-file FILE        Linux: /etc/codex-manage/codex-manage.env; macOS: INSTALL_DIR/runtime.env
  --service-name NAME    Service name. Default: codex-manage
  --host HOST            Web listen host. Default: 127.0.0.1
  --port PORT            Web listen port. Default: 4310
  --no-start             Install files and service without starting it
  -h, --help             Show this help

Environment:
  GITHUB_TOKEN or GH_TOKEN can be set for higher GitHub download rate limits.

Platforms:
  Linux: run with sudo; uses systemd.
  macOS: run as the logged-in desktop user, without sudo; uses a launchd LaunchAgent.
         Requires Node.js 22+ and Codex CLI (or the CLI bundled with the desktop app).
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

PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Linux)
    INSTALL_DIR="${INSTALL_DIR:-/opt/codex-manage}"
    ENV_FILE="${ENV_FILE:-/etc/codex-manage/codex-manage.env}"
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "On Linux this installer must run as root. Use sudo." >&2
      exit 1
    fi
    ;;
  Darwin)
    if [[ "$(id -u)" == 0 ]]; then
      echo "On macOS run this installer as your logged-in desktop user, without sudo." >&2
      echo "Omit --user deploy; that is a Linux example. Use: bash install-runtime.sh --version $VERSION" >&2
      exit 1
    fi
    if [[ -n "$SERVICE_USER" && "$SERVICE_USER" != "$(id -un)" ]]; then
      echo "On macOS the LaunchAgent must belong to the current user. Omit --user $SERVICE_USER." >&2
      exit 1
    fi
    SERVICE_USER="$(id -un)"
    INSTALL_DIR="${INSTALL_DIR:-$HOME/Library/Application Support/Codex Manage}"
    ENV_FILE="${ENV_FILE:-$INSTALL_DIR/runtime.env}"
    ;;
  *)
    echo "Unsupported platform: $PLATFORM. This installer supports Linux (systemd) and macOS (launchd)." >&2
    exit 1
    ;;
esac

if [[ "$INSTALL_DIR" != /* || "$ENV_FILE" != /* ]]; then
  echo "--install-dir and --env-file must be absolute paths." >&2
  exit 2
fi
if [[ ! "$SERVICE_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "Invalid service name: $SERVICE_NAME" >&2
  exit 2
fi

if [[ -z "$SERVICE_USER" ]]; then
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER:-}" != "root" ]]; then
    SERVICE_USER="$SUDO_USER"
  else
    SERVICE_USER="$(id -un)"
  fi
fi

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

need_command tar
if [[ "$PLATFORM" == Linux ]]; then
  need_command systemctl
  need_command getent
  CHECKSUM_COMMAND=(sha256sum)
else
  need_command launchctl
  need_command plutil
  need_command curl
  CHECKSUM_COMMAND=(shasum -a 256)
  LAUNCH_DOMAIN="gui/$(id -u)"
  SERVICE_LABEL="ai.foxhello.$SERVICE_NAME"
  SERVICE_FILE="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
  if ! launchctl print "$LAUNCH_DOMAIN" >/dev/null 2>&1; then
    echo "macOS installation requires a logged-in desktop session for this user ($LAUNCH_DOMAIN)." >&2
    exit 1
  fi
fi

if [[ -z "$LOCAL_PACKAGE" ]]; then
  need_command curl
  need_command "${CHECKSUM_COMMAND[0]}"
elif [[ -n "$LOCAL_CHECKSUM" || -f "${LOCAL_PACKAGE}.sha256" ]]; then
  need_command "${CHECKSUM_COMMAND[0]}"
fi

if [[ -n "$LOCAL_PACKAGE" && "$LOCAL_PACKAGE" == *.zip ]]; then
  need_command unzip
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "User not found: $SERVICE_USER" >&2
  echo "Create/login with the same user that owns the real Codex sessions, then rerun with --user." >&2
  exit 1
fi

if [[ -z "$SERVICE_GROUP" ]]; then
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
fi

if [[ "$PLATFORM" == Linux ]]; then
  USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
else
  USER_HOME="$HOME"
fi
if [[ -z "$USER_HOME" || ! -d "$USER_HOME" ]]; then
  echo "Cannot determine home directory for user: $SERVICE_USER" >&2
  exit 1
fi

run_as_service_user() {
  if [[ "$PLATFORM" == Darwin ]]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    su - "$SERVICE_USER" -c "$(printf '%q ' "$@")"
  fi
}

detect_codex_path() {
  if [[ "$PLATFORM" == Darwin ]]; then
    local candidate
    if [[ -n "${CODEX_CLI_PATH:-}" ]]; then
      command -v "$CODEX_CLI_PATH" 2>/dev/null || true
      return
    fi
    candidate="$(command -v codex 2>/dev/null || true)"
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
    for candidate in \
      /Applications/Codex.app/Contents/Resources/codex \
      /Applications/ChatGPT.app/Contents/Resources/codex \
      /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
    return
  fi
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

# Validate prerequisites before downloading or changing an installed release.
NODE_PATH="$(detect_node_path)"
if [[ -z "$NODE_PATH" ]]; then
  echo "Required command not found: node. Install Node.js 22+ and rerun in a terminal where node is in PATH." >&2
  exit 1
fi
if [[ "$PLATFORM" == Darwin ]]; then
  if ! "$NODE_PATH" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
    echo "macOS installation requires Node.js 22+. Found: $NODE_PATH" >&2
    exit 1
  fi
  CODEX_PATH="$(detect_codex_path)"
  "$NODE_PATH" --input-type=module - "$INSTALL_DIR" "$ENV_FILE" "${CODEX_HOME:-$USER_HOME/.codex}" "$CODEX_PATH" <<'NODE'
for (const value of process.argv.slice(2)) {
  if (/[\r\n']/.test(value)) throw new Error('Installation paths cannot contain quotes or newlines');
}
NODE
  if [[ ! -f "$ENV_FILE" && -z "$CODEX_PATH" ]]; then
    echo "Codex CLI not found. Install it (npm install -g @openai/codex), run codex login, then rerun." >&2
    exit 1
  fi
fi

curl_download() {
  local url="$1"
  local output="$2"
  local token
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  local args=(-fsSL --connect-timeout 20 --max-time 180 --retry 3 --retry-delay 2)
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
    need_command "${CHECKSUM_COMMAND[0]}"
    if [[ ! -f "$LOCAL_CHECKSUM" ]]; then
      echo "Local checksum file not found: $LOCAL_CHECKSUM" >&2
      exit 1
    fi
    cp "$LOCAL_CHECKSUM" "$CHECKSUM_FILE"
    (
      cd "$TMP_DIR"
      "${CHECKSUM_COMMAND[@]}" -c codex-manage-runtime.tgz.sha256
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
    "${CHECKSUM_COMMAND[@]}" -c codex-manage-runtime.tgz.sha256
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

if [[ "$PLATFORM" == Darwin ]]; then
  # Release a running process before replacing files (including same-version reinstall).
  if launchctl print "$LAUNCH_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1; then
    launchctl bootout "$LAUNCH_DOMAIN/$SERVICE_LABEL"
  fi
  mkdir -p "$RELEASES_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/logs" "$(dirname "$ENV_FILE")"
  chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
else
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$RELEASES_DIR"
fi
rm -rf "$RELEASE_DIR"
mv "$EXTRACT_DIR/codex-manage" "$RELEASE_DIR"
if [[ "$PLATFORM" == Linux ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$RELEASE_DIR"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
if [[ "$PLATFORM" == Linux ]]; then
  chown -h "$SERVICE_USER:$SERVICE_GROUP" "$CURRENT_LINK"
fi

if [[ "$PLATFORM" == Linux ]]; then
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$USER_HOME/.codex-manage"
  install -d -m 755 "$(dirname "$ENV_FILE")"
fi

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
  if [[ "$PLATFORM" == Darwin ]]; then
    # Quoted paths work with Node's --env-file, including spaces and # in paths.
    "$NODE_PATH" --input-type=module - "$ENV_FILE" "$CODEX_PATH" "${CODEX_HOME:-$USER_HOME/.codex}" "$INSTALL_DIR" <<'NODE'
import fs from 'node:fs';
const [file,cli,codexHome,installDir]=process.argv.slice(2);
const quote=value=>`'${value}'`;
let env=fs.readFileSync(file,'utf8');
env=env.replace(/^CODEX_CLI_PATH=.*$/m,()=>`CODEX_CLI_PATH=${quote(cli)}`)
  .replace(/^CODEX_SESSIONS_DIR=.*$/m,()=>`CODEX_SESSIONS_DIR=${quote(codexHome+'/sessions')}`)
  .replace(/^CODEX_MANAGE_METADATA_FILE=.*$/m,()=>`CODEX_MANAGE_METADATA_FILE=${quote(installDir+'/data/session-metadata.json')}`);
env+=`CODEX_MANAGE_COLLABORATION_FILE=${quote(installDir+'/data/collaboration.json')}\n`;
if (process.env.CODEX_HOME) env+=`CODEX_HOME=${quote(codexHome)}\n`;
fs.writeFileSync(file,env,{mode:0o600});
NODE
  fi
  echo "Created $ENV_FILE with generated credentials."
else
  echo "Keeping existing $ENV_FILE."
fi

if [[ "$PLATFORM" == Linux ]]; then
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
else
  mkdir -p "$(dirname "$SERVICE_FILE")"
  "$NODE_PATH" --input-type=module - "$SERVICE_FILE" "$SERVICE_LABEL" "$NODE_PATH" "$CURRENT_LINK" "$ENV_FILE" "$USER_HOME" "$INSTALL_DIR/logs" <<'NODE'
import fs from 'node:fs';
const [file,label,node,cwd,env,home,logs]=process.argv.slice(2);
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const str=value=>`<string>${xml(value)}</string>`;
fs.writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${str(label)}
<key>ProgramArguments</key><array>${[node,'--env-file='+env,'dist/server/index.js'].map(str).join('')}</array>
<key>WorkingDirectory</key>${str(cwd)}
<key>EnvironmentVariables</key><dict><key>HOME</key>${str(home)}<key>PATH</key>${str(process.env.PATH??'/usr/bin:/bin:/usr/sbin:/sbin')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>3</integer>
<key>StandardOutPath</key>${str(logs+'/stdout.log')}
<key>StandardErrorPath</key>${str(logs+'/stderr.log')}
</dict></plist>\n`,{mode:0o600});
NODE
  plutil -lint "$SERVICE_FILE"
fi

ln -sfn "$ENV_FILE" "$INSTALL_DIR/env"
ln -sfn "$SERVICE_FILE" "$INSTALL_DIR/service"
ln -sfn "$CURRENT_LINK/build-info.txt" "$INSTALL_DIR/build-info.txt"

if [[ "$PLATFORM" == Linux ]]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  if [[ "$START_SERVICE" == "1" ]]; then
    systemctl restart "$SERVICE_NAME"
    systemctl --no-pager --full status "$SERVICE_NAME" || true
  fi
else
  if [[ "$START_SERVICE" == "1" ]]; then
    launchctl enable "$LAUNCH_DOMAIN/$SERVICE_LABEL"
    launchctl bootstrap "$LAUNCH_DOMAIN" "$SERVICE_FILE"
    CHECK_PORT="$("$NODE_PATH" --env-file="$ENV_FILE" -p 'process.env.CODEX_WEB_PORT || "4310"')"
    CHECK_HOST="$("$NODE_PATH" --env-file="$ENV_FILE" -p 'process.env.CODEX_WEB_HOST || "127.0.0.1"')"
    if [[ "$CHECK_HOST" == 0.0.0.0 || "$CHECK_HOST" == :: ]]; then CHECK_HOST=127.0.0.1; fi
    if [[ "$CHECK_HOST" == *:* ]]; then CHECK_HOST="[$CHECK_HOST]"; fi
    READY=0
    for ((attempt=0; attempt<30; attempt++)); do
      if launchctl print "$LAUNCH_DOMAIN/$SERVICE_LABEL" | sed -n 's/^[[:space:]]*state = //p' | head -1 | /usr/bin/grep -qx running \
        && [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://$CHECK_HOST:$CHECK_PORT/api/health" || true)" == 401 ]]; then
        READY=1
        break
      fi
      sleep 1
    done
    if [[ "$READY" != 1 ]]; then
      echo "macOS service did not become ready. Check $INSTALL_DIR/logs/stderr.log and launchctl print $LAUNCH_DOMAIN/$SERVICE_LABEL" >&2
      exit 1
    fi
    echo "macOS LaunchAgent started: $SERVICE_LABEL"
  fi
fi
if [[ "$START_SERVICE" == 0 ]]; then
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

if [[ "$PLATFORM" == Darwin ]]; then
  cat <<EOF
macOS service (starts when this user logs in; stops on logout):
  open:         http://${CHECK_HOST:-$HOST}:${CHECK_PORT:-$PORT}
  credentials:  $ENV_FILE (CODEX_WEB_PASSWORD)
  restart:      launchctl kickstart -k $LAUNCH_DOMAIN/$SERVICE_LABEL
  stop:         launchctl bootout $LAUNCH_DOMAIN/$SERVICE_LABEL
  start:        launchctl bootstrap $LAUNCH_DOMAIN "$SERVICE_FILE"
  logs:         $INSTALL_DIR/logs

EOF
fi
