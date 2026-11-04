// Research only: Node.js 22+, isolated temporary sessions, localhost model stub.
// No real user sessions or inference credentials are loaded.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
const researchDir = await mkdtemp(join(tmpdir(), 'codex-continuation-probe-'));
const researchHome = join(researchDir, 'codex-home');
const researchWorkspace = join(researchDir, 'workspace');
await mkdir(researchHome); await mkdir(researchWorkspace);
const mockRequests = [];
const mockServer = createHttpServer(async(req,res) => {
  let raw=''; for await (const chunk of req) raw+=chunk;
  if(req.method === 'GET') {res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({object:'list',data:[]})); return;}
  const body=JSON.parse(raw || '{}'); mockRequests.push(body);
  const message={id:'msg_mock_'+mockRequests.length,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'Synthetic research result: phase one is complete; next task is phase two.',annotations:[]}]};
  const response={id:'resp_mock_'+mockRequests.length,object:'response',created_at:1793328000,status:'completed',model:'research-local-stub',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const send=(type,value)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...value})+'\n\n');
  send('response.created',{response:{...response,status:'in_progress',output:[]}});
  send('response.output_item.added',{output_index:0,item:{...message,status:'in_progress',content:[]}});
  send('response.output_text.delta',{output_index:0,content_index:0,item_id:message.id,delta:message.content[0].text});
  send('response.output_item.done',{output_index:0,item:message});
  send('response.completed',{response}); res.end();
});
await new Promise(resolve=>mockServer.listen(0,'127.0.0.1',resolve));
const mockPort=mockServer.address().port;
await writeFile(join(researchHome, 'config.toml'), `check_for_update_on_startup = false
model = "research-local-stub"
model_provider = "research"
[model_providers.research]
name = "Offline research stub"
base_url = "http://127.0.0.1:${mockPort}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
const probeEnv = { ...process.env, CODEX_HOME: researchHome };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY']) delete probeEnv[key];
const probeBinary = process.env.RESEARCH_CODEX_BIN || 'codex';
const cliVersion = execFileSync(probeBinary, ['--version'], { encoding: 'utf8' }).trim();
const startedAt = new Date().toISOString();
const processes = [];
const sourceIds = [];
const connections = [];
const observations = [];
function record(name, data) { const row = { name, ...data }; observations.push(row); console.log(JSON.stringify(row)); }
function rpcSocket(socket) {
  let serial=0; const pending=new Map(); const notifications=[];
  socket.addEventListener('message', (event) => {
    const msg=JSON.parse(String(event.data));
    if (msg.id != null && pending.has(msg.id)) {
      const task=pending.get(msg.id); pending.delete(msg.id); clearTimeout(task.timer);
      if (msg.error) task.reject(Object.assign(new Error(msg.error.message), { rpcCode: msg.error.code })); else task.resolve(msg.result);
    } else if (msg.method) notifications.push(msg);
  });
  return { socket, notifications, async request(method,params={}) {
    const id=++serial;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{pending.delete(id); reject(new Error('timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
    });
  }};
}
async function allocatePort() {
  const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
async function launch() {
  const port=await allocatePort(); const endpoint=`ws://127.0.0.1:${port}`;
  const child=spawn(probeBinary,['app-server','--listen',endpoint],{cwd:researchWorkspace,env:probeEnv,stdio:['ignore','pipe','pipe']});
  processes.push(child); let stderr=''; child.stderr.on('data',data=>{stderr+=data;}); child.stdout.resume();
  for (let attempt=0;attempt<100;attempt++) {
    try { const response=await fetch(`http://127.0.0.1:${port}/readyz`); if(response.ok) return {endpoint,child,getStderr:()=>stderr}; } catch {}
    if(child.exitCode !== null) throw new Error('server exited: '+stderr.slice(-2000));
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('server startup timed out: '+stderr.slice(-2000));
}
async function connect(endpoint,name) {
  const socket=new WebSocket(endpoint); await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const client=rpcSocket(socket); connections.push(socket);
  await client.request('initialize',{clientInfo:{name,title:name,version:'0.0.0'},capabilities:{experimentalApi:true}});
  socket.send(JSON.stringify({method:'initialized'})); return client;
}
async function attempt(name,operation) {
  try { const data=await operation(); record(name,{ok:true,...data}); return data; }
  catch(error) { record(name,{ok:false,error:error.message,rpcCode:error.rpcCode}); return null; }
}
try {
  const hostA=await launch(); const hostB=await launch();
  const a1=await connect(hostA.endpoint,'probe_a1'); const a2=await connect(hostA.endpoint,'probe_a2'); const b=await connect(hostB.endpoint,'probe_b');
  for(const historyMode of ['legacy','paginated']) {
    const started=await a1.request('thread/start',{cwd:researchWorkspace,historyMode});
    const id=started.thread.id; sourceIds.push({historyMode,id}); record(historyMode+'_start',{ok:true,threadId:id,path:started.thread.path,historyMode:started.thread.historyMode});
    await attempt(historyMode+'_synthetic_completed_turn',async()=>{
      const r=await a1.request('turn/start',{threadId:id,input:[{type:'text',text:'Synthetic research task: complete phase one.',text_elements:[]}]});
      const deadline=Date.now()+12000;
      while(!a1.notifications.some(n=>n.method==='turn/completed' && n.params?.threadId===id && n.params?.turn?.id===r.turn.id)) {if(Date.now()>deadline)throw new Error('mock turn did not complete'); await new Promise(resolve=>setTimeout(resolve,50));}
      const completed=a1.notifications.find(n=>n.method==='turn/completed' && n.params?.threadId===id && n.params?.turn?.id===r.turn.id);
      return {turnStatus:completed.params.turn.status,turnError:completed.params.turn.error};
    });
    await attempt(historyMode+'_same_server_resume',async()=>{const r=await a2.request('thread/resume',{threadId:id,excludeTurns:true});return {threadId:r.thread.id,sameId:r.thread.id===id};});
    await attempt(historyMode+'_different_server_read',async()=>{const r=await b.request('thread/read',{threadId:id});return {threadId:r.thread.id};});
    await attempt(historyMode+'_different_server_resume',async()=>{const r=await b.request('thread/resume',{threadId:id,excludeTurns:true});return {threadId:r.thread.id,sameId:r.thread.id===id};});
    const forked=await attempt(historyMode+'_different_server_fork',async()=>{
      const r=await b.request('thread/fork',{threadId:id,excludeTurns:true});
      return {threadId:r.thread.id,sameId:r.thread.id===id,forkedFromId:r.thread.forkedFromId};
    });
    if(forked) await attempt(historyMode+'_fork_context_continuity',async()=>{
      const r=await b.request('turn/start',{threadId:forked.threadId,input:[{type:'text',text:'Synthetic research task: continue with phase two.',text_elements:[]}]});
      const deadline=Date.now()+12000;
      while(!b.notifications.some(n=>n.method==='turn/completed' && n.params?.threadId===forked.threadId && n.params?.turn?.id===r.turn.id)) {if(Date.now()>deadline)throw new Error('mock fork turn did not complete'); await new Promise(resolve=>setTimeout(resolve,50));}
      const request=mockRequests.at(-1); const data=JSON.stringify(request.input);
      return {newTurnId:r.turn.id,requestContainsPreviousUser:data.includes('complete phase one'),requestContainsPreviousAssistant:data.includes('phase one is complete'),requestContainsNewUser:data.includes('continue with phase two')};
    });
    await attempt(historyMode+'_unsubscribe_a2',async()=>await a2.request('thread/unsubscribe',{threadId:id}));
    await attempt(historyMode+'_unsubscribe_a1',async()=>await a1.request('thread/unsubscribe',{threadId:id}));
    await attempt(historyMode+'_different_server_resume_after_unsubscribe',async()=>{const r=await b.request('thread/resume',{threadId:id,excludeTurns:true});return {threadId:r.thread.id};});
  }
  a1.socket.close(); a2.socket.close();
  hostA.child.kill('SIGTERM');
  await new Promise(resolve=>hostA.child.once('exit',resolve));
  for(const {historyMode,id} of sourceIds) {
    await attempt(historyMode+'_different_server_resume_after_owner_exit',async()=>{const r=await b.request('thread/resume',{threadId:id,excludeTurns:true});return {threadId:r.thread.id,sameId:r.thread.id===id};});
  }
  const expected = [];
  for (const mode of ['legacy', 'paginated']) {
    const find = suffix => observations.find(row => row.name === mode + '_' + suffix);
    for (const suffix of ['synthetic_completed_turn', 'same_server_resume', 'different_server_read', 'different_server_fork', 'fork_context_continuity', 'unsubscribe_a1', 'unsubscribe_a2', 'different_server_resume_after_owner_exit']) {
      expected.push({ name: mode + '_' + suffix, passed: find(suffix)?.ok === true });
    }
    for (const suffix of ['different_server_resume', 'different_server_resume_after_unsubscribe']) {
      const row = find(suffix);
      expected.push({ name: mode + '_' + suffix, passed: row?.ok === false && /active writer/i.test(row.error) });
    }
    const continuity = find('fork_context_continuity');
    expected.push({ name: mode + '_context_preserved', passed: continuity?.requestContainsPreviousUser === true && continuity?.requestContainsPreviousAssistant === true && continuity?.requestContainsNewUser === true });
    expected.push({ name: mode + '_original_id_preserved', passed: find('same_server_resume')?.sameId === true && find('different_server_resume_after_owner_exit')?.sameId === true });
  }
  record('verification', { passed: expected.every(check => check.passed), checks: expected });
  if (!expected.every(check => check.passed)) process.exitCode = 1;
  record('scope',{probeBinary,cliVersion,startedAt,realUserSessionsAccessed:false,realModelRequests:0,localMockRequests:mockRequests.length,researchDir});
} catch(error) { record('fatal',{ok:false,error:error.message}); process.exitCode=1; }
finally {
  mockServer.close();
  for(const socket of connections) socket.close();
  for(const child of processes) child.kill('SIGTERM');
  await writeFile(join(researchDir,'results.json'),JSON.stringify(observations,null,2)+'\n');
  if (process.env.RESEARCH_REPORT_PATH) await writeFile(process.env.RESEARCH_REPORT_PATH, JSON.stringify(observations,null,2)+'\n');
  setTimeout(()=>{for(const child of processes) if(child.exitCode===null) child.kill('SIGKILL');},1500).unref();
}
