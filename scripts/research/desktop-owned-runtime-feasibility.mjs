#!/usr/bin/env node
/** Isolated SRF-02: official Desktop starts the one app-server; Manage attaches afterwards.
 * No pre-started server, no CODEX_APP_SERVER_WS_URL, no real sessions/auth/model calls.
 * Requires macOS, installed official Desktop, repository dependencies, Google Chrome.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(join(repo,'package.json'));
const {WebSocket}=require('ws'),{chromium}=require('playwright');
const app=process.env.RESEARCH_DESKTOP_APP||'/Applications/ChatGPT.app',binary=join(app,'Contents/Resources/codex-cli/bin/codex');
// Keep Unix socket paths below the platform limit, including daemon's fixed suffix.
const root=await mkdtemp('/tmp/cdo-'),output=resolve(process.env.RESEARCH_REPORT_DIR||join(root,'evidence'));
await mkdir(output,{recursive:true});
const report={item:'SRF-02',date:new Date().toISOString(),experimentDirectory:root,checks:[],environment:{},scope:'Desktop-owned app-server launch chain, actual official Desktop + unchanged Manage',isolation:{realHomeUsed:false,realInferenceUsed:false,desktopPackageModified:false,productionCodeChanged:false}};
const children=[],connections=[],events=[],modelRequests=[],log=createWriteStream(join(output,'rpc-events.ndjson'));
let mock,chrome,context,desktopBrowser,desktopPage,desktop,managePage,manager,managePort,apiBase,threadId,activeHome,activeProfile;
let counter=0,requestCounter=0,sequence=0,cleaning=false,ownerState,firstOwner;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function poll(fn,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch{}await pause(150);}throw new Error('Condition timed out; last='+JSON.stringify(last));}
function check(id,criterion,pass,evidence={}){const c={id,criterion,outcome:pass?'pass':'fail',evidence};report.checks.push(c);console.log(JSON.stringify(c));return c;}
async function stage(id,criterion,fn){try{await fn();}catch(e){const c={id,criterion,outcome:'blocked',evidence:{error:String(e.stack||e)}};report.checks.push(c);console.log(JSON.stringify(c));}}
function envFor(home){const env={...process.env,CODEX_HOME:home};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_CLI_PATH','CODEX_APP_SERVER_FORCE_CLI','CODEX_APP_SERVER_WS_URL','CODEX_APP_SERVER_USE_LOCAL_DAEMON','CODEX_APP_TOOLS_PIPE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];return env;}
function launch(command,args,env,name){const c=spawn(command,args,{cwd:repo,env,stdio:['ignore','pipe','pipe']});children.push(c);const stream=createWriteStream(join(root,name+'.log'),{flags:'a'});c.stdout.pipe(stream,{end:false});c.stderr.pipe(stream,{end:false});c.on('exit',()=>stream.end());c.on('error',e=>stream.write(String(e)));return c;}
function processes(){return execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]}:null;}).filter(Boolean);}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
async function prepare(name){const home=join(root,name+'-home'),profile=join(root,name+'-profile'),workspace=join(root,name+'-workspace');for(const p of[home,profile,workspace])await mkdir(p);await writeFile(join(home,'config.toml'),`check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Desktop-owned runtime local stub"\nbase_url = "http://127.0.0.1:${mock.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);await writeFile(join(home,'auth.json'),'{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');await writeFile(join(home,'.codex-global-state.json'),JSON.stringify({'electron-workspace-roots':[workspace],'electron-saved-workspace-roots':[workspace],'active-workspace-roots':[workspace],'electron-workspace-root-labels':{[workspace]:'Desktop Owned Runtime Research'}}));return{home,profile,workspace};}
async function startDesktop(setup,extra={},name='desktop'){
  desktop=launch(join(app,'Contents/MacOS/ChatGPT'),['--user-data-dir='+setup.profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{...envFor(setup.home),CODEX_ELECTRON_USER_DATA_PATH:setup.profile,CODEX_ELECTRON_START_IN_BACKGROUND:'1',CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH:'1',...extra},name);
  const port=await poll(async()=>Number((await readFile(join(setup.profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),40000);
  desktopBrowser=await chromium.connectOverCDP('http://127.0.0.1:'+port);desktopPage=await poll(()=>desktopBrowser.contexts()[0]?.pages().find(p=>p.url().startsWith('app:')));
  await desktopPage.addLocatorHandler(desktopPage.getByRole('button',{name:'继续使用当前模型',exact:true}),async locator=>locator.click());
  await poll(async()=>await desktopPage.locator('[contenteditable="true"]').count(),30000);await pause(2500);
}
async function sendDesktop(marker){await desktopPage.locator('[contenteditable="true"]').first().fill(marker);await desktopPage.getByRole('button',{name:/^(发送|Send|Send message)$/}).click({timeout:30000});}
async function reply(page,marker,timeout=30000){await page.getByText('Local stub completed '+marker,{exact:true}).waitFor({timeout});}
function record(connection,direction,message){const p=message.params||{},item=p.item||{},t=message.result?.thread;const e={seq:++sequence,at:Date.now(),connection,direction,method:message.method,id:message.id,client:p.clientInfo?.name,threadId:p.threadId||p.thread?.id||t?.id,turnId:p.turnId||p.turn?.id,itemType:item.type,status:p.status||p.turn?.status||t?.status,error:message.error,markers:[...new Set([...JSON.stringify(message).matchAll(/DOR-[A-Z0-9-]+/g)].map(m=>m[0]))]};events.push(e);log.write(JSON.stringify(e)+'\n');}
async function rpc(socketPath,name='dor_observer'){
  const connection=++counter,socket=new WebSocket('ws://localhost/rpc',{createConnection:()=>net.createConnection(socketPath)}),pending=new Map();connections.push(socket);
  await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
  socket.on('message',raw=>{const m=JSON.parse(raw);record(connection,'server_to_client',m);if(!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  socket.on('error',()=>{});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++requestCounter,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},12000);pending.set(id,{resolve,reject,timer});const m={id,method,params};record(connection,'client_to_server',m);socket.send(JSON.stringify(m));});
  await request('initialize',{clientInfo:{name,version:'1.0'},capabilities:{experimentalApi:true}});socket.send(JSON.stringify({method:'initialized',params:{}}));return{socket,request};
}
async function api(path,data){const r=await context.request.fetch(apiBase+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{data})});return{status:r.status(),body:await r.json()};}
const runtime=async()=>(await api('/api/sessions/'+threadId+'/runtime')).body.runtime;
async function startManage(){manager=launch(process.execPath,['--import','tsx','src/server/index.ts'],{...envFor(join(root,'manage-home')),NODE_ENV:'production',CODEX_CLI_PATH:join(root,'manage-proxy'),CODEX_WEB_HOST:'127.0.0.1',CODEX_WEB_PORT:String(managePort),CODEX_WEB_PASSWORD:'dor-local-test',CODEX_WEB_SESSION_SECRET:'dor-local-only-session-secret',CODEX_SESSIONS_DIR:join(activeHome,'sessions'),CODEX_MANAGE_METADATA_FILE:join(root,'manage-metadata.json'),CODEX_MANAGE_COLLABORATION_FILE:join(root,'manage-collaboration.json'),CODEX_WEB_CLIENT_DIR:join(root,'manage-client')},'manage');await poll(async()=>{const r=await fetch(apiBase+'/api/health');return r.status===401||r.status===403;});await api('/api/login',{password:'dor-local-test'});}
async function shots(name){await desktopPage.screenshot({path:join(output,name+'-desktop.png')});await managePage.screenshot({path:join(output,name+'-manage.png'),fullPage:true});}
async function owner(){return JSON.parse(await readFile(join(root,'owner-state.json'),'utf8'));}
async function cleanup(){
 if(cleaning)return;cleaning=true;try{await chrome?.close();}catch{}try{await desktopBrowser?.close();}catch{}
 for(const child of[...children].reverse())await stop(child);
 for(const s of connections)s.terminate();
 for(const line of processes()){if(line.pid!==process.pid&&line.command.includes(root))try{process.kill(line.pid,'SIGTERM');}catch{}}
 for(const s of[firstOwner,ownerState])if(s&&alive(s.serverPid))try{process.kill(s.serverPid,'SIGTERM');}catch{}
 mock?.closeAllConnections();mock?.close();await new Promise(r=>log.end(r));
 report.summary=Object.fromEntries(['pass','fail','blocked'].map(k=>[k,report.checks.filter(c=>c.outcome===k).length]));await writeFile(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(output,'model-requests.json'),JSON.stringify(modelRequests,null,2)+'\n');console.log(JSON.stringify({output,summary:report.summary}));
}
process.once('SIGINT',()=>cleanup().then(()=>process.exit(130)));process.once('SIGTERM',()=>cleanup().then(()=>process.exit(143)));
try{
 report.environment={desktopVersion:execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim(),cliVersion:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),nodeVersion:process.version};
 report.protectedRealProcesses=processes().filter(p=>p.command.startsWith(app+'/')&&(p.command===join(app,'Contents/MacOS/ChatGPT')||p.command.includes('app-server')));
 mock=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"object":"list","data":[]}');return;}let body;try{body=JSON.parse(raw||'{}');}catch{body={};}const users=(body.input||[]).filter(x=>x.role==='user'),marker=JSON.stringify(users.at(-1)||{}).match(/DOR-[A-Z0-9-]+/)?.[0]||'DOR-REPLY',n=modelRequests.length+1,text='Local stub completed '+marker;modelRequests.push({index:n,path:req.url,marker,userMarkers:[...new Set([...JSON.stringify(users).matchAll(/DOR-[A-Z0-9-]+/g)].map(m=>m[0]))],assistantMarkers:[...new Set([...JSON.stringify((body.input||[]).filter(x=>x.role==='assistant')).matchAll(/DOR-[A-Z0-9-]+/g)].map(m=>m[0]))]});const item={type:'message',id:'msg_dor_'+n,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},response={id:'resp_dor_'+n,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'research-local-stub',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const send=(type,rest)=>{if(!res.destroyed)res.write('event: '+type+'\ndata: '+JSON.stringify({type,...rest})+'\n\n');};send('response.created',{response:{...response,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});if(marker.includes('SLOW'))await pause(8000);send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:text});send('response.output_item.done',{output_index:0,item});send('response.completed',{response});res.end();});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const baseline=await prepare('flag-only'),control=join(baseline.home,'app-server-control/app-server-control.sock');
 check('empty-daemon-precondition','No daemon or shared listener is pre-started',!existsSync(control),{controlSocket:control});
 await startDesktop(baseline,{CODEX_APP_SERVER_USE_LOCAL_DAEMON:'1'},'flag-only-desktop');
 const baselinePid=desktop.pid,baselineServer=await poll(()=>processes().find(p=>p.ppid===baselinePid&&p.command.includes('app-server')));
 await pause(3500);
 const daemonAvailable=existsSync(control);
 check('daemon-flag-autostart','Daemon flag alone makes Desktop launch a reusable daemon',daemonAvailable,{daemonSocketExists:daemonAvailable,desktopPid:baselinePid,privateChild:baselineServer});
 await desktopPage.screenshot({path:join(output,'daemon-flag-only-desktop.png')});
 await writeFile(join(output,'daemon-flag-observation.json'),JSON.stringify({desktopPid:baselinePid,child:baselineServer,controlSocketExists:daemonAvailable},null,2));
 await desktopBrowser.close();await stop(desktop);if(alive(baselineServer.pid))try{process.kill(baselineServer.pid,'SIGTERM');}catch{}
 const setup=await prepare('owned');activeHome=setup.home;activeProfile=setup.profile;
 const socketPath=join(root,'server.sock'),adapterConfig={binary,socketPath,packagePath:join(repo,'package.json'),logPath:join(root,'adapter-events.ndjson'),serverLogPath:join(root,'owned-server.log'),statePath:join(root,'owner-state.json')};
 await writeFile(join(root,'adapter-config.json'),JSON.stringify(adapterConfig,null,2));
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(join(root,'desktop-codex'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(repo,'scripts/research/desktop-owned-cli-adapter.mjs'))} --config ${quote(join(root,'adapter-config.json'))} "$@"\n`,{mode:0o700});
 const bridge=`import{createRequire}from'node:module';import{createInterface}from'node:readline';import net from'node:net';const require=createRequire(${JSON.stringify(join(repo,'package.json'))}),WebSocket=require('ws');const s=new WebSocket('ws://localhost/rpc',{createConnection:()=>net.createConnection(process.argv[2])}),q=[];createInterface({input:process.stdin}).on('line',line=>s.readyState===WebSocket.OPEN?s.send(line):q.push(line)).on('close',()=>s.close());s.on('open',()=>{for(const line of q)s.send(line)});s.on('message',raw=>process.stdout.write(raw.toString()+'\\n'));s.on('error',e=>{process.stderr.write(e.message+'\\n');process.exitCode=1});s.on('close',()=>process.exit());process.on('SIGTERM',()=>{s.close();setTimeout(()=>process.exit(),200)});`;
 await writeFile(join(root,'manage-bridge.mjs'),bridge);
 await writeFile(join(root,'manage-proxy'),`#!/bin/sh\nif [ "$1" = "app-server" ]; then\n exec ${quote(process.execPath)} ${quote(join(root,'manage-bridge.mjs'))} ${quote(socketPath)}\nfi\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
 check('adapter-no-prestarted-service','Before starting Desktop the reusable service does not exist',!existsSync(socketPath)&&!existsSync(adapterConfig.statePath),{socketPath});
 await startDesktop(setup,{CODEX_CLI_PATH:join(root,'desktop-codex')});
 ownerState=await poll(async()=>{const s=await owner();return existsSync(socketPath)?s:false;});firstOwner=ownerState;report.firstOwner=ownerState;
 const ps=processes(),adapterProcess=ps.find(p=>p.pid===ownerState.adapterPid),serverProcess=ps.find(p=>p.pid===ownerState.serverPid);
 check('desktop-owns-server','Desktop starts adapter which starts the sole official reusable app-server',ownerState.desktopPid===desktop.pid&&adapterProcess?.ppid===desktop.pid&&serverProcess?.ppid===ownerState.adapterPid,{desktopPid:desktop.pid,adapter:adapterProcess,server:serverProcess,serverArgs:ownerState.serverArgs});
 const observer=await rpc(socketPath);await sendDesktop('DOR-DESKTOP-ONE');await reply(desktopPage,'DOR-DESKTOP-ONE',90000);
 threadId=(await observer.request('thread/list',{limit:30})).data?.find(t=>!t.ephemeral&&t.preview?.includes('DOR-DESKTOP-ONE'))?.id;if(!threadId)throw new Error('Persisted desktop-created thread not found');report.threadId=threadId;
 check('desktop-first-turn','Official Desktop talks using its own newly launched reusable backend',true,{threadId,serverPid:ownerState.serverPid});
 const onlyServers=processes().filter(p=>p.ppid===ownerState.adapterPid&&p.command.includes('app-server'));
 check('one-official-server','Both future clients will reuse one official app-server process',onlyServers.length===1&&onlyServers[0].pid===ownerState.serverPid,{servers:onlyServers});
 execFileSync(join(repo,'node_modules/.bin/vite'),['build','--outDir',join(root,'manage-client'),'--emptyOutDir'],{cwd:repo,stdio:'pipe'});
 await mkdir(join(root,'manage-home'));for(const file of['config.toml','auth.json'])await copyFile(join(activeHome,file),join(root,'manage-home',file));
 const p=net.createServer();await new Promise(r=>p.listen(0,'127.0.0.1',r));managePort=p.address().port;await new Promise(r=>p.close(r));apiBase='http://127.0.0.1:'+managePort;
 chrome=await chromium.launch({channel:process.env.RESEARCH_BROWSER_CHANNEL||'chrome',headless:true});context=await chrome.newContext();await startManage();managePage=await context.newPage();await managePage.goto(apiBase+'/'+threadId);await reply(managePage,'DOR-DESKTOP-ONE');
 const resumed=await api('/api/sessions/'+threadId+'/resume',{});
 check('manage-attaches-original','Actual Manage attaches to Desktop-owned backend and original thread',resumed.status===200&&resumed.body.runtime?.threadId===threadId&&alive(ownerState.serverPid),{status:resumed.status,threadId,serverPid:ownerState.serverPid});
 const managerChildren=processes().filter(p=>p.ppid===manager.pid);
 check('manage-is-client-only','Manage starts only an attachment bridge, never another official app-server',managerChildren.some(p=>p.command.includes('manage-bridge.mjs'))&&!managerChildren.some(p=>p.command.startsWith(app+'/')&&p.command.includes('app-server')),{children:managerChildren});
 const sendManage=async marker=>{await managePage.locator('textarea').fill(marker);await managePage.getByRole('button',{name:'发送消息',exact:true}).click();};
 await sendManage('DOR-MANAGE-TWO');await reply(managePage,'DOR-MANAGE-TWO');await reply(desktopPage,'DOR-MANAGE-TWO');
 check('manage-to-desktop','Manage input and reply appear in official Desktop without reload',await desktopPage.getByText('DOR-MANAGE-TWO',{exact:true}).count()===1);
 await sendDesktop('DOR-DESKTOP-THREE');await reply(desktopPage,'DOR-DESKTOP-THREE');await reply(managePage,'DOR-DESKTOP-THREE');
 check('desktop-to-manage','Desktop input and completed reply appear in Manage without reload',await managePage.getByText('DOR-DESKTOP-THREE',{exact:true}).count()===1);
 const counts={};for(const marker of['DOR-MANAGE-TWO','DOR-DESKTOP-THREE'])for(const[name,page]of[['desktop',desktopPage],['manage',managePage]])counts[name+':'+marker]={user:await page.getByText(marker,{exact:true}).count(),assistant:await page.getByText('Local stub completed '+marker,{exact:true}).count()};
 check('no-duplicate-messages','Alternating input displays exactly one user and one assistant message',Object.values(counts).every(c=>c.user===1&&c.assistant===1),counts);await shots('bidirectional');
 const input=modelRequests.find(r=>r.marker==='DOR-DESKTOP-THREE');
 check('context-preserved','Next local model request contains both clients previous user and assistant messages',input?.userMarkers.includes('DOR-DESKTOP-ONE')&&input.userMarkers.includes('DOR-MANAGE-TWO')&&input.assistantMarkers.includes('DOR-MANAGE-TWO'),input);
 await stage('running-status','Cross-client run status',async()=>{
   await sendDesktop('DOR-DESKTOP-SLOW');const r=await poll(async()=>{const r=await runtime();return r.status==='running'&&r.activeTurnId?r:false;});check('running-status','Manage receives Desktop running status and active turn',true,{status:r.status,activeTurnId:r.activeTurnId});await shots('running');await reply(managePage,'DOR-DESKTOP-SLOW');await poll(async()=>(await runtime()).status==='waiting_input');
 });
 await stop(manager);await sendDesktop('DOR-AFTER-MANAGE-EXIT');await reply(desktopPage,'DOR-AFTER-MANAGE-EXIT');
 check('manage-exit-keeps-backend','Stopping Manage leaves Desktop-owned backend and Desktop conversation working',alive(ownerState.serverPid)&&alive(desktop.pid),{serverPid:ownerState.serverPid});
 await startManage();const again=await api('/api/sessions/'+threadId+'/resume',{});await managePage.reload();await reply(managePage,'DOR-AFTER-MANAGE-EXIT');
 check('manage-reconnect','Restarted Manage reconnects to original Desktop-owned service/thread',again.status===200&&again.body.runtime?.threadId===threadId&&alive(firstOwner.serverPid),{threadId,serverPid:firstOwner.serverPid});
 await desktopBrowser.close();await stop(desktop);
 await poll(()=>!alive(firstOwner.serverPid),10000);
 check('desktop-exit-owns-lifecycle','Exiting Desktop stops the backend it started',!alive(firstOwner.serverPid),{desktopPid:firstOwner.desktopPid,adapterPid:firstOwner.adapterPid,serverPid:firstOwner.serverPid});
 const down=await poll(async()=>{const r=await runtime();return ['exited','failed','history'].includes(r.status)?r:false;});
 check('manage-observes-desktop-exit','Manage loses its live backend when Desktop exits',down.status==='exited'||down.status==='failed',{status:down.status,activeTurnId:down.activeTurnId});
 check('listener-cleanup','Desktop-owned backend removes its listener on exit',!existsSync(socketPath),{socketStillExists:existsSync(socketPath)});
 if(existsSync(socketPath))await unlink(socketPath);await unlink(join(activeProfile,'DevToolsActivePort')).catch(()=>{});
 await startDesktop(setup,{CODEX_CLI_PATH:join(root,'desktop-codex')},'desktop-restart');
 ownerState=await poll(async()=>{const s=await owner();return s.serverPid!==firstOwner.serverPid&&existsSync(socketPath)?s:false;});report.secondOwner=ownerState;
 if(!(await desktopPage.getByText('Local stub completed DOR-AFTER-MANAGE-EXIT',{exact:true}).isVisible()))await desktopPage.getByText('DOR-DESKTOP-ONE',{exact:true}).first().click();await reply(desktopPage,'DOR-AFTER-MANAGE-EXIT');
 check('desktop-restart-original-history','Restarted Desktop starts a new backend and loads original thread history',ownerState.desktopPid===desktop.pid&&ownerState.serverPid!==firstOwner.serverPid,{threadId,oldServerPid:firstOwner.serverPid,newServerPid:ownerState.serverPid});
 const reload=await api('/api/runtime/reload',{}),reattach=await api('/api/sessions/'+threadId+'/resume',{});await managePage.reload();await reply(managePage,'DOR-AFTER-MANAGE-EXIT');
 check('manage-reattach-new-owned-server','After explicit reload/resume Manage reconnects to Desktop new backend',reload.status===200&&reattach.status===200&&reattach.body.runtime?.threadId===threadId,{reloadStatus:reload.status,resumeStatus:reattach.status,threadId,serverPid:ownerState.serverPid});
 await sendManage('DOR-MANAGE-AFTER-DESKTOP-RESTART');await reply(managePage,'DOR-MANAGE-AFTER-DESKTOP-RESTART');
 let desktopLive=true;try{await reply(desktopPage,'DOR-MANAGE-AFTER-DESKTOP-RESTART',10000);}catch{desktopLive=false;}
 check('desktop-restart-live-subscription','Restarted Desktop shows Manage new reply within 10s without its own input',desktopLive,{threadId,manageShowsReply:true,desktopShowsReply:desktopLive});await shots('restart-before-activation');
 await sendDesktop('DOR-DESKTOP-AFTER-RESTART');await reply(managePage,'DOR-DESKTOP-AFTER-RESTART');
 let desktopOwnReply=true;try{await reply(desktopPage,'DOR-DESKTOP-AFTER-RESTART',10000);}catch{desktopOwnReply=false;}
 await sendManage('DOR-MANAGE-AFTER-ACTIVATION');await reply(managePage,'DOR-MANAGE-AFTER-ACTIVATION');
 let desktopExternalReply=true;try{await reply(desktopPage,'DOR-MANAGE-AFTER-ACTIVATION',10000);}catch{desktopExternalReply=false;}
 const recoveredInput=modelRequests.find(r=>r.marker==='DOR-MANAGE-AFTER-ACTIVATION');
 check('continued-after-both-restarts','Both clients submit to original backend thread with preserved context after explicit reattach',recoveredInput?.userMarkers.includes('DOR-DESKTOP-ONE')&&recoveredInput.userMarkers.includes('DOR-DESKTOP-AFTER-RESTART')&&recoveredInput.assistantMarkers.includes('DOR-DESKTOP-AFTER-RESTART'),{threadId,serverPid:ownerState.serverPid,input:recoveredInput});
 check('desktop-restart-ui-recovery','After its own input restarted Desktop shows both new replies within 10s',desktopOwnReply&&desktopExternalReply,{desktopOwnReply,desktopExternalReply,manageShowsBothReplies:true});await shots('reconnected');
 const protectedNow=processes();check('real-desktop-preserved','Previously running official Desktop/backends remain alive',report.protectedRealProcesses.filter(p=>p.command.startsWith('/Applications/ChatGPT.app/')).every(p=>protectedNow.some(n=>n.pid===p.pid)),{protectedPids:report.protectedRealProcesses.filter(p=>p.command.startsWith('/Applications/ChatGPT.app/')).map(p=>p.pid)});
 await writeFile(join(output,'desktop-final.txt'),await desktopPage.locator('body').innerText());await writeFile(join(output,'manage-final.txt'),await managePage.locator('body').innerText());
 const adapterEvents=(await readFile(adapterConfig.logPath,'utf8')).trim().split('\n').map(l=>JSON.parse(l));await writeFile(join(output,'desktop-launch-chain.json'),JSON.stringify(adapterEvents,null,2)+'\n');
}catch(e){report.fatal=String(e.stack||e);console.error(report.fatal);process.exitCode=1;for(const[name,page]of[['desktop',desktopPage],['manage',managePage]])try{if(page){await page.screenshot({path:join(output,'fatal-'+name+'.png')});await writeFile(join(output,'fatal-'+name+'.txt'),await page.locator('body').innerText());}}catch{}}
finally{await cleanup();process.exit(process.exitCode||0);}
