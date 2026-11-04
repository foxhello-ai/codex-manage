#!/usr/bin/env node
// Compare native writer ownership across CLI versions, without Manage or real sessions.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const binaries=process.argv.slice(2);if(!binaries.length)throw Error('Provide one or more CLI binary paths');
const root=await mkdtemp('/tmp/writer-version-'),output=resolve(process.env.RESEARCH_REPORT_DIR||root);
await mkdir(output,{recursive:true});
const report={at:new Date().toISOString(),root,isolation:{manageCodeLoaded:false,realSessionsUsed:false,realCredentialsUsed:false,realInferenceUsed:false},versions:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const mockRequests=[];const children=[];let current;
async function poll(fn,timeout=45000){const until=Date.now()+timeout;while(Date.now()<until){const r=await fn();if(r)return r;await pause(50);}throw Error('Condition timed out');}
const mock=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"object":"list","data":[]}');return;}const b=JSON.parse(raw||'{}'),users=(b.input||[]).filter(i=>i.role==='user'),last=JSON.stringify(users.at(-1)||{}),marker=last.includes('VERSION-SECOND')?'VERSION-SECOND':'VERSION-FIRST';mockRequests.push({version:current.version,marker,inputContainsFirst:JSON.stringify(b.input).includes('VERSION-FIRST')});const text='Local stub completed '+marker,n=mockRequests.length,item={id:'msg_version_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},response={id:'resp_version_'+n,object:'response',created_at:Math.floor(Date.now()/1000),model:'research-local-stub',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};res.writeHead(200,{'content-type':'text/event-stream'});const send=(type,rest)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...rest})+'\n\n');send('response.created',{response:{...response,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:text});send('response.output_item.done',{output_index:0,item});send('response.completed',{response});res.end();});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
function launch(binary,env,cwd){const child=spawn(binary,['app-server'],{cwd,env,stdio:['pipe','pipe','pipe']});children.push(child);let nextId=0,stderr='';const pending=new Map(),notifications=[];child.stderr.on('data',d=>{stderr+=d;});child.on('error',()=>{});createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.id!=null&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error.message),{rpcCode:m.error.code})):p.resolve(m.result);}else if(m.method)notifications.push(m);});return {child,notifications,get stderr(){return stderr;},request:(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');}),notify:(method,params={})=>child.stdin.write(JSON.stringify({method,params})+'\n')};}
async function stop(client){if(!client||client.child.exitCode!==null||client.child.signalCode!==null)return;client.child.kill('SIGTERM');await Promise.race([new Promise(r=>client.child.once('exit',r)),pause(2500)]);if(client.child.exitCode===null&&client.child.signalCode===null){client.child.kill('SIGKILL');await new Promise(r=>client.child.once('exit',r));}}
async function attempt(name,fn){try{const value=await fn();const row={name,ok:true,...value};current.observations.push(row);console.log(JSON.stringify({version:current.version,...row}));return row;}catch(e){const row={name,ok:false,error:e.message,rpcCode:e.rpcCode};current.observations.push(row);console.log(JSON.stringify({version:current.version,...row}));return row;}}
async function turn(client,threadId,marker){const r=await client.request('turn/start',{threadId,input:[{type:'text',text:marker,text_elements:[]}]});const completed=await poll(()=>client.notifications.find(n=>n.method==='turn/completed'&&n.params?.threadId===threadId&&n.params?.turn?.id===r.turn.id));if(completed.params.turn.status!=='completed')throw Error(JSON.stringify(completed.params.turn));return {threadId,turnId:r.turn.id,status:completed.params.turn.status};}
try{
 for(let index=0;index<binaries.length;index++){
  const binary=binaries[index],home=join(root,'home-'+index),workspace=join(root,'workspace-'+index);await mkdir(home);await mkdir(workspace);
  current={binary,version:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),home,observations:[]};report.versions.push(current);
  const env={...process.env,CODEX_HOME:home};for(const key of['OPENAI_API_KEY','CODEX_API_KEY','AZURE_OPENAI_API_KEY','CODEX_CLI_PATH','CODEX_APP_SERVER_WS_URL','CODEX_APP_SERVER_USE_LOCAL_DAEMON','CODEX_APP_TOOLS_PIPE_PATH','CODEX_APP_SERVER_FORCE_CLI'])delete env[key];
  await writeFile(join(home,'config.toml'),`check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Writer version audit local stub"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);await writeFile(join(home,'auth.json'),'{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
  let a,b;try{
   // Initialize the original owner before starting the second process; avoid racing fresh-home SQLite migrations.
   a=launch(binary,env,workspace);await a.request('initialize',{clientInfo:{name:'audit_a',version:'1.0'},capabilities:{experimentalApi:true}});a.notify('initialized');
   b=launch(binary,env,workspace);await b.request('initialize',{clientInfo:{name:'audit_b',version:'1.0'},capabilities:{experimentalApi:true}});b.notify('initialized');current.pids={a:a.child.pid,b:b.child.pid};
   current.requestedHistoryMode=process.env.RESEARCH_HISTORY_MODE||'legacy';
   const started=await a.request('thread/start',{cwd:workspace,historyMode:current.requestedHistoryMode}),id=started.thread.id;current.threadId=id;current.returnedHistoryMode=started.thread.historyMode;
   await attempt('owner_completed_turn',()=>turn(a,id,'VERSION-FIRST'));await pause(300);
   await attempt('same_server_resume',async()=>{const r=await a.request('thread/resume',{threadId:id});return {threadId:r.thread.id,sameId:r.thread.id===id};});
   await attempt('different_server_read',async()=>{const r=await b.request('thread/read',{threadId:id,includeTurns:true});return {threadId:r.thread.id};});
   const resumed=await attempt('different_server_resume_while_owner_alive',async()=>{const r=await b.request('thread/resume',{threadId:id});return {threadId:r.thread.id,sameId:r.thread.id===id};});
   if(resumed.ok)await attempt('different_server_turn_while_owner_alive',()=>turn(b,id,'VERSION-SECOND'));
   await stop(a);
   await attempt('different_server_resume_after_owner_exit',async()=>{const r=await b.request('thread/resume',{threadId:id});return {threadId:r.thread.id,sameId:r.thread.id===id};});
   await attempt('different_server_turn_after_owner_exit',()=>turn(b,id,'VERSION-SECOND'));
  }catch(e){current.fatal=String(e.stack||e);console.error(current.fatal);process.exitCode=1;}
  finally{await stop(a);await stop(b);current.stderr={a:a?.stderr.slice(-5000),b:b?.stderr.slice(-5000)};}
 }
}finally{mock.closeAllConnections();mock.close();for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');report.mockRequests=mockRequests;await writeFile(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,versions:report.versions.map(v=>({version:v.version,observations:v.observations,fatal:v.fatal}))}));}
