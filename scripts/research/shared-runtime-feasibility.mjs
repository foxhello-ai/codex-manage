#!/usr/bin/env node
/** Isolated, opt-in real official desktop + current codex-manage feasibility probe.
 * No real Codex home/auth/sessions are loaded. Only localhost synthetic inference.
 * macOS + installed official app + npm install + Google Chrome required.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'package.json'));
const { WebSocket, WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const app = process.env.RESEARCH_DESKTOP_APP || '/Applications/ChatGPT.app';
const binary = join(app, 'Contents/Resources/codex-cli/bin/codex');
const root = await mkdtemp(join(tmpdir(), 'codex-shared-feasibility-'));
const output = resolve(process.env.RESEARCH_REPORT_DIR || join(root, 'evidence'));
const home = join(root, 'codex-home'), workspace = join(root, 'workspace'), profile = join(root, 'desktop-profile');
for (const p of [output, home, workspace, profile]) await mkdir(p, { recursive: true });
const report = {
  item: 'SRF-01', date: new Date().toISOString(), scope: 'official local Work/Codex desktop, shared app-server, actual codex-manage UI',
  isolation: { realHomeUsed: false, realInferenceUsed: false, productionCodeChanged: false },
  checks: [], environment: {}, experimentDirectory: root
};
const children = [], sockets = new Set(), events = [], modelRequests = [], approvalIssued = new Set();
const rpcLog = createWriteStream(join(output, 'rpc-events.ndjson'));
let mock, gatewayHttp, gateway, server, desktop, manager, desktopBrowser, browser, desktopPage, manage, context, endpoint, threadId, apiBase;
let nextConnection = 0, nextRequest = 0, sequence = 0, cleaning = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, timeout = 15000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch {} await pause(150); }
  throw new Error('Timed out waiting for condition; last=' + JSON.stringify(last));
}
function check(id, criterion, pass, evidence = {}) {
  const result = { id, criterion, outcome: pass ? 'pass' : 'fail', evidence };
  report.checks.push(result); console.log(JSON.stringify(result)); return result;
}
function blocked(id, criterion, error) {
  const result = { id, criterion, outcome: 'blocked', evidence: { error: String(error.stack || error) } };
  report.checks.push(result); console.log(JSON.stringify(result));
}
async function stage(id, criterion, fn) { try { await fn(); } catch (e) { blocked(id, criterion, e); } }
function launch(command, args, env, name) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const log = createWriteStream(join(root, name + '.log'), { flags: 'a' });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.on('exit', () => log.end()); child.on('error', e => log.write(String(e)));
  return child;
}
const env = { ...process.env, CODEX_HOME: home };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'ELECTRON_RUN_AS_NODE']) delete env[key];
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), pause(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
function observe(connection, direction, raw) {
  let message; try { message = JSON.parse(raw.toString()); } catch { return; }
  const event = { seq: ++sequence, at: Date.now(), connection, direction, message };
  events.push(event);
  // Keep diagnostic identifiers/statuses, excluding bundled prompts/config/plugin/account payloads.
  const p = message.params || {}, item = p.item || {}, resultThread = message.result?.thread;
  const compact = {
    seq: event.seq, at: event.at, connection, direction, method: message.method, id: message.id,
    client: p.clientInfo?.name, threadId: p.threadId || p.thread?.id || resultThread?.id,
    turnId: p.turnId || p.turn?.id, itemType: item.type, requestId: p.requestId,
    status: p.status || p.turn?.status || resultThread?.status,
    markers: [...JSON.stringify(message).matchAll(/SRF-[A-Z0-9-]+/g)].map(m => m[0]).filter((v,i,a) => a.indexOf(v) === i),
    error: message.error, settings: message.method === 'thread/settings/updated' ? p.threadSettings : undefined
  };
  rpcLog.write(JSON.stringify(compact) + '\n');
}
async function rpcClient() {
  const socket = new WebSocket(endpoint); sockets.add(socket);
  await new Promise((r,j) => { socket.once('open',r); socket.once('error',j); });
  const pending = new Map();
  socket.on('message', raw => { const m = JSON.parse(raw); if (!m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const request = (method, params) => new Promise((resolve,reject) => {
    const id = ++nextRequest, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 15000);
    pending.set(id, {resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
  });
  await request('initialize', { clientInfo: {name:'srf_observer',version:'1.0'}, capabilities: {experimentalApi:true} });
  socket.send(JSON.stringify({method:'initialized',params:{}}));
  return { socket, request };
}
async function api(path, data, method) {
  const res = await context.request.fetch(apiBase + path, { method: method || (data === undefined ? 'GET' : 'POST'), ...(data === undefined ? {} : {data}) });
  return { status: res.status(), body: await res.json() };
}
const runtime = async () => (await api('/api/sessions/' + threadId + '/runtime')).body.runtime;
async function sendDesktop(marker) {
  const input = desktopPage.locator('[contenteditable="true"]').first();
  await input.fill(marker);
  await desktopPage.getByRole('button',{name:/^(发送|Send|Send message)$/}).click({timeout:30000});
}
async function sendManage(marker) {
  await manage.locator('textarea').fill(marker); await manage.getByRole('button', {name:'发送消息',exact:true}).click();
}
async function visibleReply(page, marker, timeout = 25000) {
  await page.getByText('Local stub completed ' + marker, {exact:true}).waitFor({timeout});
}
async function startManager(watchHome) {
  manager = launch(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    ...env, CODEX_HOME: watchHome, NODE_ENV:'production', CODEX_CLI_PATH:join(root,'codex-shared-proxy'),
    CODEX_WEB_HOST:'127.0.0.1', CODEX_WEB_PORT:String(report.environment.managePort),
    CODEX_WEB_PASSWORD:'srf-local-test', CODEX_WEB_SESSION_SECRET:'srf-local-only-session-secret',
    CODEX_SESSIONS_DIR:join(home,'sessions'), CODEX_MANAGE_METADATA_FILE:join(root,'metadata.json'),
    CODEX_MANAGE_COLLABORATION_FILE:join(root,'collaboration.json'), CODEX_WEB_CLIENT_DIR:join(root,'manage-client')
  }, 'manage');
  await poll(async () => (await fetch(apiBase + '/api/health')).status === 401);
}
async function screenshot(name) {
  await desktopPage.screenshot({path:join(output,name+'-desktop.png')});
  await manage.screenshot({path:join(output,name+'-manage.png'),fullPage:true});
}
async function cleanup() {
  if (cleaning) return; cleaning = true;
  try { await browser?.close(); } catch {}
  try { await desktopBrowser?.close(); } catch {}
  for (const child of [...children].reverse()) await stop(child);
  // Electron crash handlers and plugin helpers can outlive their direct parent.
  // Match this run's random temp directory; never match a real user app/home.
  for (const line of execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n')) {
    const match=line.trim().match(/^(\d+)\s+(.*)$/);
    if(match&&Number(match[1])!==process.pid&&match[2].includes(root)) {
      try { process.kill(Number(match[1]),'SIGTERM'); } catch {}
    }
  }
  for (const socket of sockets) socket.terminate();
  for (const socket of gateway?.clients || []) socket.terminate();
  gateway?.close(); gatewayHttp?.close(); mock?.closeAllConnections(); mock?.close();
  await new Promise(r => rpcLog.end(r));
  report.summary = Object.fromEntries(['pass','fail','blocked'].map(s => [s,report.checks.filter(x=>x.outcome===s).length]));
  await writeFile(join(output,'results.json'), JSON.stringify(report,null,2)+'\n');
  await writeFile(join(output,'model-request-summary.json'),JSON.stringify(modelRequests,null,2)+'\n');
  console.log(JSON.stringify({output,summary:report.summary}));
}
process.once('SIGINT', () => cleanup().then(()=>process.exit(130)));
process.once('SIGTERM', () => cleanup().then(()=>process.exit(143)));
try {
  if (process.platform !== 'darwin' || !existsSync(binary)) throw new Error('Requires installed macOS official desktop; use RESEARCH_DESKTOP_APP to select bundle.');
  report.environment.desktopVersion = execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();
  report.environment.cliVersion = execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
  report.environment.nodeVersion = process.version;
  mock = createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk;
    if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"object":"list","data":[]}');return;}
    let body; try {body=JSON.parse(raw||'{}');}catch{body={};}
    const marker = JSON.stringify((body.input||[]).filter(x=>x.role==='user').at(-1)||{}).match(/SRF-[A-Z0-9-]+/)?.[0] || 'SRF-REPLY';
    const requestIndex=modelRequests.length+1;
    modelRequests.push({index:requestIndex,path:req.url,marker,inputTypes:(body.input||[]).map(x=>x.type||x.role),tools:(body.tools||[]).map(t=>t.name||t.type)});
    const text='Local stub completed '+marker;
    const needsApproval=marker.includes('APPROVAL')&&!approvalIssued.has(marker)&&(body.tools||[]).some(t=>t.name==='exec_command');
    if(needsApproval)approvalIssued.add(marker);
    const item=needsApproval?{type:'function_call',id:'fc_srf_'+requestIndex,call_id:'call_srf_'+requestIndex,name:'exec_command',arguments:JSON.stringify({cmd:'printf '+marker,sandbox_permissions:'require_escalated',justification:'Allow this isolated harmless printf feasibility check?',max_output_tokens:100})}:{id:'msg_srf_'+requestIndex,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    const response={id:'resp_srf_'+requestIndex,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'research-local-stub',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const send=(type,rest)=>{if(!res.destroyed)res.write('event: '+type+'\ndata: '+JSON.stringify({type,...rest})+'\n\n');};
    send('response.created',{response:{...response,status:'in_progress',output:[]}});
    send('response.output_item.added',{output_index:0,item:needsApproval?item:{...item,status:'in_progress',content:[]}});
    if(marker.includes('SLOW')) await pause(8000);
    if(!needsApproval)send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:text});
    send('response.output_item.done',{output_index:0,item});send('response.completed',{response});res.end();
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  await writeFile(join(home,'config.toml'),`check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Shared runtime local stub"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  await writeFile(join(home,'auth.json'),'{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
  await writeFile(join(home,'.codex-global-state.json'),JSON.stringify({'electron-workspace-roots':[workspace],'electron-saved-workspace-roots':[workspace],'active-workspace-roots':[workspace],'electron-workspace-root-labels':{[workspace]:'Shared Runtime Research'}}));
  const unixSocket=join(root,'server.sock');
  server=launch(binary,['app-server','--listen','unix://'+unixSocket],env,'app-server');
  await poll(()=>existsSync(unixSocket));
  gatewayHttp=createServer((req,res)=>res.end('research'));
  gateway=new WebSocketServer({server:gatewayHttp});
  gateway.on('connection',client=>{
    const connection=++nextConnection;
    const upstream=new WebSocket('ws://localhost/rpc',{createConnection:()=>net.createConnection(unixSocket)});sockets.add(upstream);
    const queue=[];
    client.on('message',data=>{observe(connection,'client_to_server',data);if(upstream.readyState===WebSocket.OPEN)upstream.send(data.toString());else queue.push(data.toString());});
    upstream.on('open',()=>{for(const data of queue)upstream.send(data);});
    upstream.on('message',data=>{observe(connection,'server_to_client',data);if(client.readyState===WebSocket.OPEN)client.send(data.toString());});
    upstream.on('error',()=>client.close());client.on('close',()=>upstream.close());upstream.on('close',()=>client.close());
  });
  await new Promise(r=>gatewayHttp.listen(0,'127.0.0.1',r));endpoint='ws://127.0.0.1:'+gatewayHttp.address().port;
  const bridge=`import{createRequire}from'node:module';import{createInterface}from'node:readline';const require=createRequire(${JSON.stringify(join(repo,'package.json'))});const WebSocket=require('ws');const socket=new WebSocket(process.argv[2]),queue=[];createInterface({input:process.stdin}).on('line',line=>{if(socket.readyState===WebSocket.OPEN)socket.send(line);else queue.push(line)}).on('close',()=>socket.close());socket.on('open',()=>{for(const line of queue)socket.send(line)});socket.on('message',data=>process.stdout.write(data+'\\n'));socket.on('error',e=>{process.stderr.write(e.message+'\\n');process.exitCode=1});socket.on('close',()=>process.exit());process.on('SIGTERM',()=>{socket.close();setTimeout(()=>process.exit(),200)});`;
  await writeFile(join(root,'bridge.mjs'),bridge);
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  await writeFile(join(root,'codex-shared-proxy'),`#!/bin/sh\nif [ "$1" = "app-server" ]; then\n exec ${quote(process.execPath)} ${quote(join(root,'bridge.mjs'))} ${quote(endpoint)}\nfi\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
  desktop=launch(join(app,'Contents/MacOS/ChatGPT'),['--user-data-dir='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{...env,CODEX_ELECTRON_USER_DATA_PATH:profile,CODEX_APP_SERVER_WS_URL:endpoint,CODEX_ELECTRON_START_IN_BACKGROUND:'1',CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH:'1'},'desktop');
  const devPort=await poll(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),30000);
  desktopBrowser=await chromium.connectOverCDP('http://127.0.0.1:'+devPort);
  desktopPage=await poll(()=>desktopBrowser.contexts()[0]?.pages().find(p=>p.url().startsWith('app:')));
  await poll(async()=>{const button=desktopPage.getByRole('button',{name:'继续使用当前模型',exact:true});if(await button.isVisible())await button.click();return await desktopPage.locator('[contenteditable="true"]').count();},30000);
  await pause(2500);
  const introButton=desktopPage.getByRole('button',{name:'继续使用当前模型',exact:true});
  if(await introButton.isVisible())await introButton.click();
  check('official-attach','Official unmodified desktop initializes external shared app-server',events.some(e=>e.message.params?.clientInfo?.name==='Codex Desktop'),{hook:'CODEX_APP_SERVER_WS_URL',support:'internal installed-app hook, not a public compatibility promise'});
  await sendDesktop('SRF-DESKTOP-ONE');await visibleReply(desktopPage,'SRF-DESKTOP-ONE',90000);
  const initialObserver=await rpcClient();
  const listed=await initialObserver.request('thread/list',{limit:30});
  threadId=listed.data?.find(t=>!t.ephemeral&&t.preview?.includes('SRF-DESKTOP-ONE'))?.id;
  initialObserver.socket.close();
  if(!threadId)throw new Error('Could not identify persisted desktop-created thread');report.threadId=threadId;
  check('official-original-thread','Official desktop creates and completes a real protocol turn',true,{threadId});
  execFileSync(join(repo,'node_modules/.bin/vite'),['build','--outDir',join(root,'manage-client'),'--emptyOutDir'],{cwd:repo,stdio:'pipe'});
  const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));report.environment.managePort=portServer.address().port;await new Promise(r=>portServer.close(r));apiBase='http://127.0.0.1:'+report.environment.managePort;
  browser=await chromium.launch({channel:process.env.RESEARCH_BROWSER_CHANNEL||'chrome',headless:true});context=await browser.newContext();
  await startManager(home);await api('/api/login',{password:'srf-local-test'});manage=await context.newPage();await manage.goto(apiBase+'/'+threadId);await visibleReply(manage,'SRF-DESKTOP-ONE');
  const resumed=await api('/api/sessions/'+threadId+'/resume',{});
  check('manage-resume','Actual codex-manage resumes desktop original thread via temporary WS/stdin bridge',resumed.status===200&&resumed.body.runtime.threadId===threadId,{status:resumed.status,threadId:resumed.body.runtime?.threadId});
  // Deterministically reproduce the desktop global-state file triggering an unintended reload.
  const generation=(await api('/api/config')).body.runtimeReload?.generation;
  const globalState=JSON.parse(await readFile(join(home,'.codex-global-state.json'),'utf8'));globalState.srfResearchMutation=Date.now();await writeFile(join(home,'.codex-global-state.json'),JSON.stringify(globalState));
  await pause(5000);
  const afterConfig=(await api('/api/config')).body, afterWatcher=await runtime();
  check('shared-home-watcher','Shared-home UI state writes preserve subscription and active runtime',afterWatcher.status!=='history'&&afterWatcher.status!=='exited',{generationBefore:generation,generationAfter:afterConfig.runtimeReload?.generation,statusAfter:afterWatcher.status,workaroundForRemainingChecks:'separate manager watcher home; server and session directory stay shared'});
  await stop(manager);
  const manageHome=join(root,'manage-home');await mkdir(manageHome);for(const f of ['config.toml','auth.json'])await copyFile(join(home,f),join(manageHome,f));
  await startManager(manageHome);await api('/api/login',{password:'srf-local-test'});await manage.reload();await visibleReply(manage,'SRF-DESKTOP-ONE');await api('/api/sessions/'+threadId+'/resume',{});
  await sendManage('SRF-MANAGE-TWO');await visibleReply(manage,'SRF-MANAGE-TWO');await visibleReply(desktopPage,'SRF-MANAGE-TWO');
  check('manage-to-desktop','Manage user+assistant appear in official desktop without reload',await desktopPage.getByText('SRF-MANAGE-TWO',{exact:true}).count()===1);
  await sendDesktop('SRF-DESKTOP-THREE');await visibleReply(desktopPage,'SRF-DESKTOP-THREE');await visibleReply(manage,'SRF-DESKTOP-THREE');
  check('desktop-to-manage','Desktop completed user+assistant appear in Manage without reload',await manage.getByText('SRF-DESKTOP-THREE',{exact:true}).count()===1);
  const counts={};for(const marker of ['SRF-MANAGE-TWO','SRF-DESKTOP-THREE'])for(const [name,page]of[['desktop',desktopPage],['manage',manage]])counts[name+':'+marker]={user:await page.getByText(marker,{exact:true}).count(),assistant:await page.getByText('Local stub completed '+marker,{exact:true}).count()};
  check('no-visible-duplicates','Alternating input keeps one user and one assistant message per marker',Object.values(counts).every(c=>c.user===1&&c.assistant===1),counts);await screenshot('bidirectional');
  await stage('desktop-running','Desktop running and live user state',async()=>{
    await sendDesktop('SRF-DESKTOP-SLOW-FOUR');const running=await poll(async()=>{const r=await runtime();return r.status==='running'&&r.activeTurnId?r:false;});
    await pause(500);const userVisible=await manage.getByText('SRF-DESKTOP-SLOW-FOUR',{exact:true}).count();
    check('desktop-running','Desktop turn updates Manage running status and active turn ID',true,{status:running.status,activeTurnId:running.activeTurnId});
    check('live-external-user','Desktop user message appears in Manage while turn is still running',userVisible===1,{userVisible,status:(await runtime()).status});await screenshot('running');
    await visibleReply(manage,'SRF-DESKTOP-SLOW-FOUR');await poll(async()=>(await runtime()).status==='waiting_input');
    check('desktop-idle','Both clients complete the desktop turn and return to idle',await desktopPage.getByText('Local stub completed SRF-DESKTOP-SLOW-FOUR',{exact:true}).count()===1);
  });
  await stage('interrupt','Cross-client interruption',async()=>{
    await sendManage('SRF-MANAGE-SLOW-INTERRUPT');await poll(async()=>(await runtime()).status==='running');
    const stopButton=desktopPage.getByRole('button',{name:'停止',exact:true});await stopButton.waitFor();await stopButton.click();
    const r=await poll(async()=>{const r=await runtime();return r.status==='waiting_input'?r:false;});
    check('interrupt','Official desktop stops a Manage-started active turn and Manage returns idle',true,{status:r.status});
  });
  const observer=await rpcClient();await observer.request('thread/resume',{threadId});
  await stage('settings','Cross-client settings notification',async()=>{
    const before=sequence;await observer.request('thread/settings/update',{threadId,effort:'high'});await poll(async()=>(await runtime()).reasoningEffort==='high');
    check('settings','Shared thread effort update reconciles in Manage and reaches official desktop',events.some(e=>e.seq>before&&e.connection===1&&e.message.method==='thread/settings/updated'),{manageEffort:(await runtime()).reasoningEffort,desktopText:(await desktopPage.locator('body').innerText()).slice(-350)});
  });
  await stage('active-reattach','Reconnect Manage during desktop generation',async()=>{
    // Disconnect a subscriber, leaving official desktop and the shared process running.
    await api('/api/runtime/reload',{});
    const before=sequence;
    await sendDesktop('SRF-DESKTOP-SLOW-REATTACH');
    const active=await poll(()=>events.findLast(e=>e.seq>before&&e.message.method==='turn/started'&&e.message.params?.threadId===threadId));
    const response=await api('/api/sessions/'+threadId+'/resume',{});const r=response.body.runtime;
    check('active-reattach','Resume during active desktop turn recovers running state and turn ID',response.status===200&&r.status==='running'&&!!r.activeTurnId,{httpStatus:response.status,status:r?.status,activeTurnId:r?.activeTurnId,serverTurnId:active.message.params.turn.id});
    await visibleReply(desktopPage,'SRF-DESKTOP-SLOW-REATTACH');await poll(async()=>(await runtime()).status==='waiting_input');
    await visibleReply(manage,'SRF-DESKTOP-SLOW-REATTACH');
    check('post-reconnect-events','Reattached Manage receives desktop completion without a history fork',await manage.getByText('Local stub completed SRF-DESKTOP-SLOW-REATTACH',{exact:true}).count()===1);
  });
  // Exercise actual server-generated harmless command approvals in the actual desktop UI.
  await stage('approval-desktop-answer','Approval fan-out and cross-client clearing',async()=>{
    await observer.request('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}});
    const before=sequence;await sendDesktop('SRF-APPROVAL-DESKTOP');
    const request=await poll(()=>events.find(e=>e.seq>before&&e.direction==='server_to_client'&&e.message.method==='item/commandExecution/requestApproval'),20000);
    await poll(async()=>(await runtime()).pendingApprovalCount>0);
    const receivers=[...new Set(events.filter(e=>e.seq>before&&e.message.method==='item/commandExecution/requestApproval').map(e=>e.connection))];
    check('approval-fanout','Real command approval appears in official desktop and Manage',receivers.includes(1)&&receivers.some(c=>c!==1),{connections:receivers,requestId:request.message.id,managePending:(await runtime()).pendingApprovalCount});
    await screenshot('approval-pending');
    const buttons=await desktopPage.locator('button').evaluateAll(es=>es.map(e=>({text:e.innerText,label:e.getAttribute('aria-label')})));await writeFile(join(root,'approval-buttons.json'),JSON.stringify(buttons,null,2));
    const accept=desktopPage.getByRole('button',{name:/^(是，继续|批准|允许一次|允许|Approve|Yes, proceed|Run)(\s|$)/}).first();
    await accept.click({timeout:5000});await visibleReply(desktopPage,'SRF-APPROVAL-DESKTOP');await pause(500);
    const r=await runtime();const resolved=events.filter(e=>e.seq>before&&e.message.method==='serverRequest/resolved').map(e=>({connection:e.connection,params:e.message.params}));
    check('approval-cross-clear','Desktop approval answer clears Manage pending approval',r.pendingApprovalCount===0,{pending:r.pendingApprovalCount,status:r.status,resolved});await screenshot('approval-resolved');
  });
  await stage('manager-lifecycle','Manager disconnect preserves shared service and official desktop',async()=>{
    await stop(manager);await sendDesktop('SRF-DESKTOP-AFTER-MANAGE-EXIT');await visibleReply(desktopPage,'SRF-DESKTOP-AFTER-MANAGE-EXIT');
    check('manager-lifecycle','Stopping Manage only disconnects its bridge; desktop keeps original service and thread',server.exitCode===null&&desktop.exitCode===null,{serverAlive:server.exitCode===null,desktopAlive:desktop.exitCode===null,threadId});
    await startManager(manageHome);await api('/api/login',{password:'srf-local-test'});const response=await api('/api/sessions/'+threadId+'/resume',{});await manage.reload();await visibleReply(manage,'SRF-DESKTOP-AFTER-MANAGE-EXIT');
    check('manager-reconnect','Restarted Manage resumes the same thread and full latest history',response.status===200&&response.body.runtime.threadId===threadId,{threadId});
  });
  await stage('approval-manage-answer','Manage approval answer clears official desktop request',async()=>{
    await observer.request('thread/settings/update',{threadId,approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}});
    const before=sequence;await sendDesktop('SRF-APPROVAL-MANAGE');
    await poll(async()=>(await runtime()).pendingApprovalCount===1,20000);
    await manage.getByRole('button',{name:'Allow once',exact:true}).first().click();
    await visibleReply(desktopPage,'SRF-APPROVAL-MANAGE');await visibleReply(manage,'SRF-APPROVAL-MANAGE');
    const r=await runtime();const cleared=events.some(e=>e.seq>before&&e.connection===1&&e.message.method==='serverRequest/resolved');
    const desktopPending=await desktopPage.getByRole('button',{name:'允许一次',exact:true}).count();
    check('approval-manage-answer','Manage answers approval; both clients clear pending state',r.pendingApprovalCount===0&&r.status==='waiting_input'&&cleared&&desktopPending===0,{managePending:r.pendingApprovalCount,manageStatus:r.status,desktopPending,desktopReceivedResolved:cleared});await screenshot('manage-approval-answer');
  });
  await stage('desktop-reconnect','Official desktop reconnects to existing shared service',async()=>{
    await desktopBrowser.close();await stop(desktop);await unlink(join(profile,'DevToolsActivePort')).catch(()=>{});
    const before=sequence;
    desktop=launch(join(app,'Contents/MacOS/ChatGPT'),['--user-data-dir='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{...env,CODEX_ELECTRON_USER_DATA_PATH:profile,CODEX_APP_SERVER_WS_URL:endpoint,CODEX_ELECTRON_START_IN_BACKGROUND:'1',CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH:'1'},'desktop');
    const port=await poll(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),30000);
    desktopBrowser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
    desktopPage=await poll(()=>desktopBrowser.contexts()[0]?.pages().find(p=>p.url().startsWith('app:')));
    await pause(2000);
    if(!(await desktopPage.getByText('Local stub completed SRF-APPROVAL-MANAGE',{exact:true}).isVisible()))await desktopPage.getByText('SRF-DESKTOP-ONE',{exact:true}).first().click();
    await visibleReply(desktopPage,'SRF-APPROVAL-MANAGE');
    await sendDesktop('SRF-DESKTOP-RECONNECTED');await visibleReply(desktopPage,'SRF-DESKTOP-RECONNECTED');await visibleReply(manage,'SRF-DESKTOP-RECONNECTED');
    check('desktop-reconnect','Restarted official desktop continues original thread and Manage receives new turn',server.exitCode===null&&events.some(e=>e.seq>before&&e.message.method==='turn/start'&&e.message.params?.threadId===threadId&&JSON.stringify(e.message.params.input).includes('SRF-DESKTOP-RECONNECTED')),{threadId,serverAlive:server.exitCode===null});await screenshot('desktop-reconnected');
  });
  await writeFile(join(output,'desktop-final.txt'),await desktopPage.locator('body').innerText());
  await writeFile(join(output,'manage-final.txt'),await manage.locator('body').innerText());
 } catch (error) {
  report.fatal=String(error.stack||error);console.error(report.fatal);process.exitCode=1;
  try { if(desktopPage) {await desktopPage.screenshot({path:join(output,'fatal-desktop.png')});await writeFile(join(output,'fatal-desktop.txt'),await desktopPage.locator('body').innerText());} } catch {}
}
finally { await cleanup(); process.exit(process.exitCode || 0); }
