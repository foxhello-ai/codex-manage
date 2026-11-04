#!/usr/bin/env bash
set -euo pipefail

# Uses the real launchd and Codex CLI with an isolated CODEX_HOME. It never
# reads account credentials, resumes real sessions, or sends model requests.
: "${VERIFY_PACKAGE_DIR:?Directory containing codex-manage-runtime.tgz and its sha256}"
: "${VERIFY_REPORT_FILE:?Output JSON file}"
VERIFY_INSTALLER="${VERIFY_INSTALLER:-scripts/install-runtime.sh}"
VERIFY_NODE="${VERIFY_NODE:-$(command -v node)}"
if [[ "$(uname -s)" != Darwin || "$(id -u)" == 0 ]]; then
  echo "Run this verification as a logged-in macOS desktop user, without sudo." >&2
  exit 1
fi

VERIFY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-manage-install.XXXXXX")"
VERIFY_INSTALL_DIR="$VERIFY_ROOT/Runtime space & # path"
VERIFY_ENV_FILE="$VERIFY_INSTALL_DIR/runtime.env"
VERIFY_SERVICE="codex-manage-verify-$$"
VERIFY_LABEL="ai.foxhello.$VERIFY_SERVICE"
VERIFY_PLIST="$HOME/Library/LaunchAgents/$VERIFY_LABEL.plist"
VERIFY_DOMAIN="gui/$(id -u)"
VERIFY_CHECKS="$VERIFY_ROOT/checks.jsonl"
VERIFY_PORT="$("$VERIFY_NODE" --input-type=module -e 'import net from "node:net";const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
export CODEX_HOME="$VERIFY_ROOT/isolated-codex-home"
mkdir -p "$CODEX_HOME/sessions" "$(dirname "$VERIFY_REPORT_FILE")"
printf 'installation-verification-data\n' > "$CODEX_HOME/sessions/installation-verification.marker"
: > "$VERIFY_CHECKS"

cleanup() {
  local result=$?
  launchctl bootout "$VERIFY_DOMAIN/$VERIFY_LABEL" >/dev/null 2>&1 || true
  if [[ "$result" != 0 && -d "$VERIFY_INSTALL_DIR/logs" ]]; then
    cp -R "$VERIFY_INSTALL_DIR/logs" "${VERIFY_REPORT_FILE}.logs"
    echo "Failed verification logs: ${VERIFY_REPORT_FILE}.logs" >&2
  fi
  rm -f "$VERIFY_PLIST"
  rm -rf "$VERIFY_ROOT"
  return "$result"
}
trap cleanup EXIT

for package_dir in "$VERIFY_PACKAGE_DIR" "${VERIFY_PREVIOUS_PACKAGE_DIR:-$VERIFY_PACKAGE_DIR}"; do
  (cd "$package_dir" && shasum -a 256 -c codex-manage-runtime.tgz.sha256)
done
package_field() {
  tar -xOf "$1/codex-manage-runtime.tgz" codex-manage/build-info.txt | sed -n "s/^$2=//p" | head -1
}
VERIFY_VERSION="$(package_field "$VERIFY_PACKAGE_DIR" version)"
VERIFY_COMMIT="$(package_field "$VERIFY_PACKAGE_DIR" source_commit)"

install_release() {
  bash "$VERIFY_INSTALLER" \
    --install-dir "$VERIFY_INSTALL_DIR" --env-file "$VERIFY_ENV_FILE" \
    --service-name "$VERIFY_SERVICE" --host 127.0.0.1 --port "$VERIFY_PORT" "$@" || return $?
  plutil -lint "$VERIFY_PLIST"
}

check_runtime() {
  "$VERIFY_NODE" --input-type=module - "$1" "${2:-$VERIFY_VERSION}" "${3:-$VERIFY_COMMIT}" "$VERIFY_ENV_FILE" "$VERIFY_INSTALL_DIR" "$VERIFY_CHECKS" "$CODEX_HOME" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
const [label,version,commit,envFile,installDir,checksFile,codexHome]=process.argv.slice(2);
const env=parseEnv(fs.readFileSync(envFile,'utf8'));
assert.equal(fs.statSync(envFile).mode & 0o777,0o600);
assert.ok(env.CODEX_WEB_PASSWORD.length>=32);
assert.ok(env.CODEX_WEB_SESSION_SECRET.length>=32);
assert.equal(env.CODEX_HOME,codexHome);
assert.equal(env.CODEX_SESSIONS_DIR,codexHome+'/sessions');
assert.equal(env.CODEX_MANAGE_METADATA_FILE,installDir+'/data/session-metadata.json');
const build=parseEnv(fs.readFileSync(installDir+'/current/build-info.txt','utf8'));
assert.equal(build.version,version);
assert.equal(build.source_commit,commit);
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
for(const path of ['/api/me','/api/sessions?paginated=true&limit=30'])assert.equal((await fetch(base+path,{headers:{cookie}})).status,200,path);
const html=await fetch(base+'/').then(r=>{assert.equal(r.status,200);return r.text();});
const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
assert.ok(assets.length>=2);
for(const path of assets)assert.equal((await fetch(base+path)).status,200,path);
const result={label,version,sourceCommit:commit,health:true,login:true,authenticationRequired:true,frontendAssets:assets.length,codexCliVersion:health.codexCli.version,environmentMode:'0600'};
fs.appendFileSync(checksFile,JSON.stringify(result)+'\n');
console.log(JSON.stringify(result));
NODE
}

# A Linux example username must fail before downloading or writing files.
if install_release --user codex-manage-not-current-user --version "$VERIFY_VERSION" > "$VERIFY_ROOT/wrong-user.log" 2>&1; then
  echo "macOS accepted a different user" >&2
  exit 1
fi
grep -q 'current user' "$VERIFY_ROOT/wrong-user.log"
test ! -e "$VERIFY_INSTALL_DIR"

# Verify the public Release download path as well as local tgz and zip inputs.
install_release --version "$VERIFY_VERSION"
check_runtime release-download
verify_env_hash="$(shasum -a 256 "$VERIFY_ENV_FILE" | cut -d' ' -f1)"
verify_new_dir="$(readlink "$VERIFY_INSTALL_DIR/current")"
printf 'persistent-runtime-data\n' > "$VERIFY_INSTALL_DIR/data/installation-verification.marker"

install_release --package "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz"
check_runtime same-version-reinstall
zip -q -j "$VERIFY_ROOT/runtime-artifact.zip" \
  "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz" "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz.sha256"
install_release --package "$VERIFY_ROOT/runtime-artifact.zip"
check_runtime artifact-zip

if [[ -n "${VERIFY_PREVIOUS_PACKAGE_DIR:-}" ]]; then
  previous_version="$(package_field "$VERIFY_PREVIOUS_PACKAGE_DIR" version)"
  previous_commit="$(package_field "$VERIFY_PREVIOUS_PACKAGE_DIR" source_commit)"
  install_release --package "$VERIFY_PREVIOUS_PACKAGE_DIR/codex-manage-runtime.tgz"
  check_runtime previous-release "$previous_version" "$previous_commit"
  verify_previous_dir="$(readlink "$VERIFY_INSTALL_DIR/current")"
  install_release --package "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz"
  check_runtime upgrade
  launchctl bootout "$VERIFY_DOMAIN/$VERIFY_LABEL"
  ln -sfn "$verify_previous_dir" "$VERIFY_INSTALL_DIR/current"
  launchctl bootstrap "$VERIFY_DOMAIN" "$VERIFY_PLIST"
  check_runtime rollback "$previous_version" "$previous_commit"
  launchctl bootout "$VERIFY_DOMAIN/$VERIFY_LABEL"
  ln -sfn "$verify_new_dir" "$VERIFY_INSTALL_DIR/current"
  launchctl bootstrap "$VERIFY_DOMAIN" "$VERIFY_PLIST"
  check_runtime restore
fi

printf 'invalid-checksum\n' > "$VERIFY_ROOT/bad.sha256"
if install_release --package "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz" --checksum "$VERIFY_ROOT/bad.sha256" > "$VERIFY_ROOT/checksum-error.log" 2>&1; then
  echo "Installer accepted an invalid checksum" >&2
  exit 1
fi
check_runtime checksum-failure-keeps-service

launchctl kickstart -k "$VERIFY_DOMAIN/$VERIFY_LABEL"
check_runtime restart
launchctl bootout "$VERIFY_DOMAIN/$VERIFY_LABEL"
for ((attempt=0; attempt<40; attempt++)); do
  if ! curl --silent --max-time 1 "http://127.0.0.1:$VERIFY_PORT/" >/dev/null; then break; fi
  sleep 0.25
done
if curl --silent --max-time 1 "http://127.0.0.1:$VERIFY_PORT/" >/dev/null; then
  echo "Test runtime is still listening after stop" >&2
  exit 1
fi
install_release --package "$VERIFY_PACKAGE_DIR/codex-manage-runtime.tgz" --no-start
if launchctl print "$VERIFY_DOMAIN/$VERIFY_LABEL" >/dev/null 2>&1; then
  echo "--no-start unexpectedly started the service" >&2
  exit 1
fi
launchctl bootstrap "$VERIFY_DOMAIN" "$VERIFY_PLIST"
check_runtime start-after-no-start
test "$(shasum -a 256 "$VERIFY_ENV_FILE" | cut -d' ' -f1)" = "$verify_env_hash"
grep -qx 'installation-verification-data' "$CODEX_HOME/sessions/installation-verification.marker"
grep -qx 'persistent-runtime-data' "$VERIFY_INSTALL_DIR/data/installation-verification.marker"

"$VERIFY_NODE" --input-type=module - "$VERIFY_REPORT_FILE" "$VERIFY_CHECKS" "$VERIFY_VERSION" "$VERIFY_COMMIT" "$VERIFY_PACKAGE_DIR" "$VERIFY_INSTALLER" <<'NODE'
import fs from 'node:fs';import crypto from 'node:crypto';import os from 'node:os';
const [reportFile,checksFile,version,sourceCommit,packageDir,installer]=process.argv.slice(2);
const hash=path=>crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const report={version,sourceCommit,status:'passed',verifiedAt:new Date().toISOString(),platform:os.platform(),arch:os.arch(),kernel:os.release(),serviceManager:'launchd',packageSha256:hash(packageDir+'/codex-manage-runtime.tgz'),installerSha256:hash(installer),checks:fs.readFileSync(checksFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)),configurationPreserved:true,runtimeDataMarkerPreserved:true,sessionDirectoryMarkerPreserved:true,serviceStoppedAndStarted:true,noStartVerified:true,differentUserRejected:true,checksumFailureKeepsService:true,pathsWithSpacesAndXmlCharacters:true,accountLoginTested:false,modelInferenceTested:false};
fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,checks:report.checks.length,arch:report.arch,packageSha256:report.packageSha256}));
NODE
