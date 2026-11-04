#!/usr/bin/env bash
set -euo pipefail

# Runs only in a disposable Linux/systemd environment. No account credentials
# or model requests are needed to verify the installer and runtime lifecycle.
: "${VERIFY_PACKAGE_DIR:?Directory containing downloaded release assets}"
: "${VERIFY_PREVIOUS_PACKAGE_DIR:?Directory containing the previous release}"
: "${VERIFY_EXPECTED_VERSION:?Release version}"
: "${VERIFY_EXPECTED_COMMIT:?Source commit}"
: "${VERIFY_REPORT_FILE:?Output JSON file}"
VERIFY_NODE="${VERIFY_NODE:-$(command -v node)}"
VERIFY_USER="codex-manage-release-verify"
VERIFY_INSTALL_DIR="/opt/codex-manage-release-verify"
VERIFY_ENV_FILE="/etc/codex-manage-release-verify/runtime.env"
VERIFY_SERVICE="codex-manage-release-verify"
VERIFY_PORT="14319"
VERIFY_CHECKS="${VERIFY_REPORT_FILE}.checks.jsonl"
VERIFY_INSTALLER="$VERIFY_PACKAGE_DIR/install-runtime.sh"

if [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]]; then
  echo "Run this verification as root in a disposable Linux/systemd environment." >&2
  exit 1
fi
if id "$VERIFY_USER" >/dev/null 2>&1 || [[ -e "$VERIFY_INSTALL_DIR" || -e "$VERIFY_ENV_FILE" ]]; then
  echo "Verification paths/user already exist; refusing to reuse them." >&2
  exit 1
fi
mkdir -p "$(dirname "$VERIFY_REPORT_FILE")"
: > "$VERIFY_CHECKS"

cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then
    journalctl -u "$VERIFY_SERVICE" --no-pager -n 60 || true
  fi
  systemctl stop "$VERIFY_SERVICE" >/dev/null 2>&1 || true
  systemctl disable "$VERIFY_SERVICE" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$VERIFY_SERVICE.service"
  systemctl daemon-reload
  return "$result"
}
trap cleanup EXIT
useradd --create-home --shell /bin/bash "$VERIFY_USER"

for package_dir in "$VERIFY_PACKAGE_DIR" "$VERIFY_PREVIOUS_PACKAGE_DIR"; do
  (cd "$package_dir" && sha256sum -c codex-manage-runtime.tgz.sha256)
done
bash -n "$VERIFY_INSTALLER"
cmp "$VERIFY_INSTALLER" scripts/install-runtime.sh

install_release() {
  local package_dir="$1"
  local package_file="${2:-$package_dir/codex-manage-runtime.tgz}"
  systemctl stop "$VERIFY_SERVICE" >/dev/null 2>&1 || true
  # These phases deliberately restart many times within systemd's rate-limit
  # window. Reset only the verification unit before each manual lifecycle step.
  systemctl reset-failed "$VERIFY_SERVICE" >/dev/null 2>&1 || true
  bash "$VERIFY_INSTALLER" --user "$VERIFY_USER" \
    --package "$package_file" \
    --checksum "$package_dir/codex-manage-runtime.tgz.sha256" \
    --install-dir "$VERIFY_INSTALL_DIR" --env-file "$VERIFY_ENV_FILE" \
    --service-name "$VERIFY_SERVICE" --host 127.0.0.1 --port "$VERIFY_PORT"
  systemctl is-enabled --quiet "$VERIFY_SERVICE"
  systemctl is-active --quiet "$VERIFY_SERVICE"
  test "$(systemctl show "$VERIFY_SERVICE" --property User --value)" = "$VERIFY_USER"
}

check_runtime() {
  "$VERIFY_NODE" --input-type=module - "$1" "$2" "$3" "$VERIFY_ENV_FILE" "$VERIFY_INSTALL_DIR" "$VERIFY_CHECKS" "$VERIFY_EXPECTED_VERSION" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [label,version,commit,envFile,installDir,checksFile,releaseVersion]=process.argv.slice(2);
const fields=text=>Object.fromEntries(text.trim().split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
const env=fields(fs.readFileSync(envFile,'utf8'));
assert.equal(fs.statSync(envFile).mode & 0o777,0o600);
assert.ok(env.CODEX_WEB_PASSWORD.length>=32);
assert.ok(env.CODEX_WEB_SESSION_SECRET.length>=32);
const build=fields(fs.readFileSync(installDir+'/current/build-info.txt','utf8'));
assert.equal(build.version,version);
assert.equal(build.source_commit,commit);
assert.ok(!fs.existsSync(installDir+'/current/src'));
assert.ok(!fs.existsSync(installDir+'/current/.git'));
assert.ok(!fs.existsSync(installDir+'/current/tests'));
const base='http://127.0.0.1:'+env.CODEX_WEB_PORT;
let health,cookie;
for(let attempt=0;attempt<80;attempt++){
  try{
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:env.CODEX_WEB_PASSWORD})});
    if(login.ok){cookie=login.headers.get('set-cookie')?.split(';')[0];const r=await fetch(base+'/api/health',{headers:{cookie}});health=await r.json();if(r.ok&&health.ok)break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal(health?.ok,true,'Installed runtime must initialize the real Codex app-server');
assert.equal((await fetch(base+'/api/health')).status,401);
assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong-installation-password'})})).status,401);
const paths=['/api/me','/api/sessions?paginated=true&limit=30'];
if(version===releaseVersion)paths.push('/api/tasks');
for(const path of paths){const response=await fetch(base+path,{headers:{cookie}});assert.equal(response.status,200,path);await response.arrayBuffer();}
const html=await fetch(base+'/').then(r=>{assert.equal(r.status,200);return r.text();});
const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
assert.ok(assets.length>=2);
for(const path of assets){const response=await fetch(base+path);assert.equal(response.status,200,path);assert.ok((await response.arrayBuffer()).byteLength>0,path);}
const result={label,version,sourceCommit:commit,health:true,login:true,authenticationRequired:true,tasksApiChecked:version===releaseVersion,frontendAssets:assets.length,codexCliVersion:health.codexCli.version,environmentMode:'0600'};
fs.appendFileSync(checksFile,JSON.stringify(result)+'\n');
console.log(JSON.stringify(result));
NODE
}

install_release "$VERIFY_PACKAGE_DIR"
check_runtime fresh-install "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"
verify_env_hash="$(sha256sum "$VERIFY_ENV_FILE" | cut -d' ' -f1)"
verify_new_dir="$(readlink -f "$VERIFY_INSTALL_DIR/current")"
verify_user_home="$(getent passwd "$VERIFY_USER" | cut -d: -f6)"
mkdir -p "$verify_user_home/.codex/sessions"
printf 'installation-verification-data\n' > "$verify_user_home/.codex/sessions/installation-verification.marker"
chown -R "$VERIFY_USER:$VERIFY_USER" "$verify_user_home/.codex/sessions"

zip -j "$VERIFY_PACKAGE_DIR/runtime-artifact.zip" \
  "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz" "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz.sha256"
install_release "$VERIFY_PACKAGE_DIR" "$VERIFY_PACKAGE_DIR/runtime-artifact.zip"
check_runtime artifact-zip "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"

previous_info="$(tar -xOf "$VERIFY_PREVIOUS_PACKAGE_DIR/codex-manage-runtime.tgz" codex-manage/build-info.txt)"
previous_version="$(printf '%s\n' "$previous_info" | sed -n 's/^version=//p')"
previous_commit="$(printf '%s\n' "$previous_info" | sed -n 's/^source_commit=//p')"
install_release "$VERIFY_PREVIOUS_PACKAGE_DIR"
check_runtime previous-release "$previous_version" "$previous_commit"
verify_previous_dir="$(readlink -f "$VERIFY_INSTALL_DIR/current")"

install_release "$VERIFY_PACKAGE_DIR"
check_runtime upgrade "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"
test "$(sha256sum "$VERIFY_ENV_FILE" | cut -d' ' -f1)" = "$verify_env_hash"
grep -qx 'installation-verification-data' "$verify_user_home/.codex/sessions/installation-verification.marker"

systemctl stop "$VERIFY_SERVICE"
ln -sfn "$verify_previous_dir" "$VERIFY_INSTALL_DIR/current"
systemctl reset-failed "$VERIFY_SERVICE"
systemctl start "$VERIFY_SERVICE"
check_runtime rollback "$previous_version" "$previous_commit"
systemctl stop "$VERIFY_SERVICE"
ln -sfn "$verify_new_dir" "$VERIFY_INSTALL_DIR/current"
systemctl reset-failed "$VERIFY_SERVICE"
systemctl start "$VERIFY_SERVICE"
check_runtime restore "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"
systemctl reset-failed "$VERIFY_SERVICE"
systemctl restart "$VERIFY_SERVICE"
check_runtime restart "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"
systemctl stop "$VERIFY_SERVICE"
if systemctl is-active --quiet "$VERIFY_SERVICE"; then
  echo "Test service did not stop" >&2
  exit 1
fi
if curl --silent --max-time 2 "http://127.0.0.1:$VERIFY_PORT/" >/dev/null; then
  echo "Test runtime is still listening after stop" >&2
  exit 1
fi
systemctl reset-failed "$VERIFY_SERVICE"
systemctl start "$VERIFY_SERVICE"
check_runtime start "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT"
test "$(sha256sum "$VERIFY_ENV_FILE" | cut -d' ' -f1)" = "$verify_env_hash"
grep -qx 'installation-verification-data' "$verify_user_home/.codex/sessions/installation-verification.marker"

"$VERIFY_NODE" --input-type=module - "$VERIFY_REPORT_FILE" "$VERIFY_CHECKS" "$VERIFY_EXPECTED_VERSION" "$VERIFY_EXPECTED_COMMIT" "$VERIFY_PACKAGE_DIR" <<'NODE'
import fs from 'node:fs';import crypto from 'node:crypto';import os from 'node:os';
const [reportFile,checksFile,version,sourceCommit,packageDir]=process.argv.slice(2);
const hash=path=>crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const report={version,sourceCommit,status:'passed',verifiedAt:new Date().toISOString(),platform:os.platform(),arch:os.arch(),kernel:os.release(),packageSha256:hash(packageDir+'/codex-manage-runtime.tgz'),installerSha256:hash(packageDir+'/install-runtime.sh'),checks:fs.readFileSync(checksFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)),configurationPreserved:true,sessionDirectoryMarkerPreserved:true,serviceStoppedAndStarted:true,accountLoginTested:false,modelInferenceTested:false};
fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,checks:report.checks.length,packageSha256:report.packageSha256}));
NODE
