#!/usr/bin/env node
// Read-only inventory. Never starts/reconfigures the desktop or sends chat input.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const app = process.env.RESEARCH_DESKTOP_APP ?? '/Applications/ChatGPT.app';
const cli = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const root = await mkdtemp(join(tmpdir(), 'desktop-interaction-capabilities-'));
const schemaDir = join(root, 'schema');
const output = resolve(process.argv[2] ?? join(root, 'capabilities.json'));
const env = { ...process.env, CODEX_HOME: join(root, 'home') };
await mkdir(env.CODEX_HOME, { recursive: true });
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_APP_SERVER_WS_URL', 'CODEX_CLI_PATH']) delete env[key];
execFileSync(cli, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir], { env, stdio: 'pipe' });
const client = JSON.parse(await readFile(join(schemaDir, 'ClientRequest.json'), 'utf8'));
const server = JSON.parse(await readFile(join(schemaDir, 'ServerRequest.json'), 'utf8'));
function methods(schema) {
  return (schema.oneOf ?? schema.anyOf ?? []).flatMap(entry => entry.properties?.method?.enum ?? []).sort();
}
const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  return match ? [{ pid: +match[1], ppid: +match[2], command: match[3] }] : [];
});
const desktop = processes.filter(row => row.command === join(app, 'Contents/MacOS/ChatGPT'));
const backends = processes.filter(row => desktop.some(parent => parent.pid === row.ppid) && row.command.startsWith(app + '/') && row.command.includes(' app-server'));
const backendEvidence = backends.map(row => {
  let listeners = '';
  try { listeners = execFileSync('lsof', ['-a', '-p', String(row.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (error) { if (error.status !== 1) throw error; }
  return { pid: row.pid, parentPid: row.ppid, explicitListenerArgument: /--listen\s+(?!stdio)/.test(row.command), tcpListeners: listeners.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)) };
});
const exists = async path => access(path).then(() => true, () => false);
const clientMethods = methods(client), serverMethods = methods(server);
const report = {
  date: new Date().toISOString(),
  desktopVersion: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(),
  cliVersion: execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim(),
  isolation: { desktopStarted: false, desktopModified: false, startupChanged: false, chatWritten: false, credentialsLoaded: false },
  clientMethodCount: clientMethods.length,
  interactionClientMethods: clientMethods.filter(method => /approval|elicitation|requestUserInput|serverRequest/i.test(method)),
  interactionServerRequests: serverMethods.filter(method => /Approval|requestUserInput|elicitation/i.test(method)),
  nativeQueueMethods: clientMethods.filter(method => method.startsWith('thread/queue/')),
  responseRouting: 'Server request replies are JSON-RPC responses on the connection receiving the request; a request ID alone is not an external reply endpoint.',
  desktopBackends: backendEvidence,
  defaultDaemonControlSocketPresent: await exists(join(homedir(), '.codex/app-server-control/app-server-control.sock')),
  result: 'The inspected version exposes no client method for listing or answering another private backend connection’s pending requests. Default desktop backend attachment and screenshot-specific cross-client interaction remain unverified/unsupported by Manage. Native text queuing is a separate capability.',
  limits: ['Static protocol and listener inventory only; no desktop pending request was created or answered.', 'No claim that every internal or future desktop interface is impossible.']
};
await mkdir(join(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report }, null, 2));
