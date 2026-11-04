#!/usr/bin/env node
// Research only. Run with node --import tsx; no real chats, credentials, or model calls.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexAppServerClient } from '../../src/server/services/CodexAppServerClient.ts';
import { RuntimeManager } from '../../src/server/services/RuntimeManager.ts';

const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root = await mkdtemp('/tmp/unsubscribe-handoff-');
const home = join(root, 'home'), workspace = join(root, 'workspace');
const output = resolve(process.env.RESEARCH_REPORT_DIR || join(root, 'evidence'));
for (const dir of [home, workspace, output]) await mkdir(dir, { recursive: true });
const report = {
  at: new Date().toISOString(), root,
  version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
  isolation: { realSessionsUsed: false, realCredentialsUsed: false, realInferenceUsed: false, desktopModified: false },
  // A process-local override only. The default 60s delay is covered by manage-desktop-handoff.mjs.
  ownerUnloadDelaySecs: 1, checks: [], requests: [], notifications: []
};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(40); }
  throw Error('Research condition timed out');
}
function check(id, pass, evidence) {
  report.checks.push({ id, outcome: pass ? 'pass' : 'fail', evidence });
  console.log(JSON.stringify(report.checks.at(-1)));
  if (!pass) throw Error('Check failed: ' + id);
}
function markers(items) {
  return [...new Set([...JSON.stringify(items).matchAll(/UHF-[A-Z-]+/g)].map(m => m[0]))];
}
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
  const body = JSON.parse(raw || '{}'), users = (body.input || []).filter(i => i.role === 'user');
  const marker = markers(users.at(-1)).at(-1) || 'UHF-REPLY';
  report.requests.push({ marker, userMarkers: markers(users), assistantMarkers: markers((body.input || []).filter(i => i.role === 'assistant')) });
  const n = report.requests.length, text = 'Local stub completed ' + marker;
  const item = { id: 'msg_uhf_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_uhf_' + n, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'research-local-stub', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  send('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: text });
  send('response.output_item.done', { output_index: 0, item });
  send('response.completed', { response }); res.end();
});
let a, b;
try {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  await writeFile(join(home, 'config.toml'), `check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Unsubscribe handoff research"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  await writeFile(join(home, 'auth.json'), '{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'CODEX_CLI_PATH', 'CODEX_APP_SERVER_WS_URL', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_SERVER_FORCE_CLI']) delete env[key];
  a = new CodexAppServerClient({ codexCliPath: binary, env, spawnProcess: (path, args, options) => spawn(path, [...args, '-c', 'thread_unload_delay_secs=1'], options) });
  b = new CodexAppServerClient({ codexCliPath: binary, env });
  for (const [name, client] of [['a', a], ['b', b]]) {
    client.on('error', () => {});
    client.on('notification', n => {
      if (['thread/status/changed', 'thread/closed'].includes(n.method)) report.notifications.push({ client: name, at: Date.now(), ...n });
    });
    await client.start();
  }
  const runtime = new RuntimeManager(a, { writerLockRetryDelaysMs: [], historyDirectory: join(home, 'sessions') });
  const original = (await runtime.startThread(workspace)).threadId;
  const other = (await runtime.startThread(workspace)).threadId;
  report.threadId = original; report.otherThreadId = other;
  report.pids = { a: a.getSnapshot().pid, b: b.getSnapshot().pid };
  async function manageTurn(id, text) {
    await runtime.sendInput(id, { text });
    await poll(() => runtime.getRuntime(id).status === 'waiting_input');
  }
  await manageTurn(original, 'UHF-MANAGE-FIRST');
  await manageTurn(other, 'UHF-OTHER-FIRST');
  let conflict;
  try { await b.request('thread/resume', { threadId: original }); }
  catch (error) { conflict = error.message; }
  check('completed-manage-thread-still-owns-writer', /active writer/.test(conflict || ''), { conflict, runtime: runtime.getRuntime(original) });
  const unsubscribeAt = Date.now();
  const unsubscribed = await a.request('thread/unsubscribe', { threadId: original });
  check('unsubscribe-accepted', unsubscribed.status === 'unsubscribed', unsubscribed);
  await poll(() => report.notifications.find(n => n.client === 'a' && n.method === 'thread/closed' && n.params.threadId === original));
  const loaded = await a.request('thread/loaded/list', {});
  check('unload-preserves-backend-and-other-thread', !loaded.data.includes(original) && loaded.data.includes(other) && a.getSnapshot().pid === report.pids.a && runtime.getRuntime(original).status === 'history', { elapsedMs: Date.now() - unsubscribeAt, loaded: loaded.data, backend: a.getSnapshot(), releasedRuntime: runtime.getRuntime(original) });
  const resumed = await b.request('thread/resume', { threadId: original });
  check('second-backend-resumes-same-original-thread', resumed.thread.id === original, { returnedId: resumed.thread.id, originalOwnerStillAlive: a.getSnapshot().status === 'ready' });
  let completion;
  b.on('notification', n => { if (n.method === 'turn/completed' && n.params.threadId === original) completion = n; });
  await b.request('turn/start', { threadId: original, input: [{ type: 'text', text: 'UHF-SECOND-BACKEND', text_elements: [] }] });
  await poll(() => completion);
  const secondInput = report.requests.find(r => r.marker === 'UHF-SECOND-BACKEND');
  check('original-context-preserved-after-handoff', completion.params.turn.status === 'completed' && secondInput?.userMarkers.includes('UHF-MANAGE-FIRST') && secondInput?.assistantMarkers.includes('UHF-MANAGE-FIRST'), { completion: completion.params, modelInput: secondInput });
  await manageTurn(other, 'UHF-OTHER-STILL-WORKS');
  check('other-manage-thread-continues', a.getSnapshot().pid === report.pids.a && report.requests.some(r => r.marker === 'UHF-OTHER-STILL-WORKS' && r.userMarkers.includes('UHF-OTHER-FIRST')), { pid: a.getSnapshot().pid, runtime: runtime.getRuntime(other) });
} catch (error) {
  report.fatal = String(error.stack || error); process.exitCode = 1; console.error(report.fatal);
} finally {
  await a?.stop(); await b?.stop(); mock.closeAllConnections(); mock.close();
  report.summary = Object.fromEntries(['pass', 'fail'].map(outcome => [outcome, report.checks.filter(c => c.outcome === outcome).length]));
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, summary: report.summary }));
}
