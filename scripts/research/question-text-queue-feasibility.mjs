#!/usr/bin/env node
// Isolated real app-server probe: a queued text message vs a pending question reply.
// Never starts, modifies, or controls the desktop. No real auth/model is used.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const root = await mkdtemp(join(tmpdir(), 'question-text-queue-'));
const home = join(root, 'home'), workspace = join(root, 'workspace');
for (const path of [home, workspace]) await mkdir(path, { recursive: true });
const output = resolve(process.argv[2] ?? join(root, 'question-text-queue.json'));
const env = { ...process.env, CODEX_HOME: home };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_APP_SERVER_WS_URL', 'CODEX_CLI_PATH', 'CODEX_APP_TOOLS_PIPE_PATH']) delete env[key];
const report = {
  checkedAt: new Date().toISOString(), cliVersion: execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim(),
  isolation: { desktopStarted: false, desktopModified: false, realCredentialsUsed: false, realModelInferenceUsed: false },
  scope: 'Actual installed CLI, two isolated private stdio app-servers and native queue, shared temporary CODEX_HOME, localhost model stub; no official desktop process or UI automation.',
  checks: [], modelRequests: []
};
const children = [], events = [];
let mock;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(read, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = read(); if (value) return value; await pause(50); }
  throw new Error('Timed out waiting for protocol condition');
}
function check(id, pass, evidence) {
  report.checks.push({ id, passed: !!pass, evidence });
  if (!pass) throw new Error('Check failed: ' + id);
}
function rpc(name) {
  const child = spawn(cli, ['app-server'], { env, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map(); let nextId = 100000;
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      events.push({ client: name, at: Date.now(), ...message });
    } else {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out; ' + stderr)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    close() {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Probe closed')); }
      pending.clear(); lines.close(); child.kill('SIGTERM');
    }
  };
}
const clients = [];
try {
  mock = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const index = report.modelRequests.length + 1;
    const tools = (body.tools ?? []).flatMap(tool => tool.type === 'namespace' ? (tool.tools ?? []).map(t => t.name) : [tool.name]);
    const toolOutputs = (body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output);
    const userTexts = (body.input ?? []).filter(item => item.role === 'user').flatMap(item => (item.content ?? []).map(content => content.text ?? ''));
    report.modelRequests.push({ index, path: req.url, toolAvailable: tools.includes('request_user_input'), toolOutputs, userTexts });
    const question = index === 1;
    const item = question ? {
      type: 'function_call', id: 'fc_question', call_id: 'call_question', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'screen', header: '审核界面', question: '请选择界面', options: [
        { label: '方案 A', description: '界面 A' }, { label: '方案 B', description: '界面 B' }
      ] }] })
    } : { type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'QUESTION-ANSWERED', annotations: [] }] };
    const response = { id: 'resp_' + index, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'research-local-stub', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item });
    if (!question) emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: 'QUESTION-ANSWERED' });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response }); res.end();
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  await writeFile(join(home, 'config.toml'), `check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Question queue local probe"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  await writeFile(join(home, 'auth.json'), '{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
  for (const name of ['owner', 'external']) {
    const client = rpc(name); clients.push(client);
    await client.request('initialize', { clientInfo: { name: 'question_queue_probe', version: '1.0' }, capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized', params: {} });
  }
  const [owner, external] = clients;
  const started = await owner.request('thread/start', { cwd: workspace, model: 'research-local-stub', modelProvider: 'research', sandbox: 'read-only', approvalPolicy: 'never' });
  const threadId = started.thread.id; report.threadId = threadId;
  const turn = await owner.request('turn/start', { threadId, input: [{ type: 'text', text: 'QUESTION-PROBE', text_elements: [] }], collaborationMode: { mode: 'plan', settings: { model: 'research-local-stub' } } });
  const pendingQuestion = await poll(() => events.find(event => event.client === 'owner' && event.method === 'item/tool/requestUserInput'));
  report.pendingRequest = pendingQuestion;
  check('actual-structured-question-created', pendingQuestion.params.questions[0]?.id === 'screen', { requestId: pendingQuestion.id, turnId: turn.turn.id });
  const queued = await external.request('thread/queue/add', { threadId, clientUserMessageId: 'question-queue-probe-text', input: [{ type: 'text', text: 'QUEUE-TEXT-方案 B', text_elements: [] }] });
  await pause(1500);
  const queue = await external.request('thread/queue/list', { threadId, limit: 20 });
  const completedBeforeReply = events.some(event => event.method === 'turn/completed');
  check('queued-text-does-not-answer-pending-question', report.modelRequests.length === 1 && !completedBeforeReply && queue.data.some(item => item.id === queued.queuedSubmission.id), { observationMs: 1500, modelRequests: report.modelRequests.length, turnCompleted: completedBeforeReply, queueId: queued.queuedSubmission.id });
  // A response sent on another process's connection does not reach the owner.
  external.send({ id: pendingQuestion.id, result: { answers: { screen: { answers: ['方案 B'] } } } });
  await pause(500);
  check('same-request-id-on-other-private-connection-does-not-answer', report.modelRequests.length === 1 && !events.some(event => event.method === 'turn/completed'), { observationMs: 500 });
  owner.send({ id: pendingQuestion.id, result: { answers: { screen: { answers: ['方案 B'] } } } });
  await poll(() => events.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id));
  check('structured-text-answer-on-original-connection-resumes-turn', report.modelRequests.length >= 2 && JSON.stringify(report.modelRequests[1].toolOutputs).includes('方案 B'), { toolOutputs: report.modelRequests[1].toolOutputs });
  const nextCompleted = await poll(() => events.find(event => event.method === 'turn/completed' && event.params.turn.id !== turn.turn.id));
  check('queued-text-is-consumed-as-next-turn-after-question-is-answered', report.modelRequests.some(request => request.userTexts.includes('QUEUE-TEXT-方案 B')), { originalTurnId: turn.turn.id, nextTurnId: nextCompleted.params.turn.id });
  const afterQueue = await external.request('thread/queue/list', { threadId, limit: 20 });
  report.queueAfterAnswer = afterQueue;
  report.conclusion = 'The answer may be text, but it must resolve the pending question on its original connection. Native queued chat text and a JSON-RPC reply sent to another private process do not resolve it in this isolated app-server probe.';
  report.limits = ['This does not exercise the running official desktop or every internal interface.', 'No desktop UI bridge, real model, or real user question was tested.'];
} catch (error) {
  report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  mock?.closeAllConnections(); mock?.close();
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, checks: report.checks, error: report.error }, null, 2));
}
