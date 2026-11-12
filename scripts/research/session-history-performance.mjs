#!/usr/bin/env -S node --import tsx
// Reads history only. Does not resume, subscribe, enqueue input or acquire a writer.
import { CodexAppServerClient } from '../../src/server/services/CodexAppServerClient.ts';
import { SessionService } from '../../src/server/services/SessionService.ts';
import { JsonlSessionParser } from '../../src/server/services/JsonlSessionParser.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const output = resolve(process.argv[3] ?? '/tmp/codex-manage-history-performance.json');
const cli = process.env.RESEARCH_CODEX_CLI ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const client = new CodexAppServerClient({ codexCliPath: cli });
client.on('error', error => console.error(error.message));
const calls = [];
const request = client.request.bind(client);
client.request = async (method, params) => { calls.push(method); return request(method, params); };
try {
  await client.start();
  const threadId = process.argv[2] || (await client.request('thread/list', { limit: 1, sortKey: 'updated_at' })).data[0].id;
  const service = new SessionService(client, undefined, new JsonlSessionParser(join(homedir(), '.codex/sessions')));
  const samples = [];
  for (const mode of ['full', 'recent', 'full', 'recent']) {
    const from = calls.length, start = performance.now();
    const detail = await service.getSessionDetail(threadId, mode === 'recent' ? { turnLimit: 20 } : {});
    samples.push({ mode, milliseconds: Math.round(performance.now() - start), bytes: Buffer.byteLength(JSON.stringify(detail)), turns: detail.turns.length, historyMode: detail.historyMode, nextPage: Boolean(detail.historyPage?.nextCursor), methods: calls.slice(from) });
  }
  if (calls.some(method => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(method))) throw Error('Unexpected writer operation');
  const report = { date: new Date().toISOString(), threadId, samples, limits: 'Same local thread and reader, sequential samples; not an end-to-end network latency benchmark.', writerOperations: 0 };
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await client.stop(); }
