#!/usr/bin/env node
/** Exercise actual Manage UI and native desktop queue without replacing the desktop backend. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(repo,'package.json')),{chromium}=require('playwright');
const app='/Applications/ChatGPT.app',desktopBinary=join(app,'Contents/MacOS/ChatGPT');
const cli=join(app,'Contents/Resources/codex-cli/bin/codex');
const root=await mkdtemp('/tmp/mhi-'),home=join(root,'home'),profile=join(root,'profile'),workspace=join(root,'workspace');
const output=resolve(process.env.RESEARCH_REPORT_DIR||join(root,'evidence'));
for(const p of[home,profile,workspace,output])await mkdir(p,{recursive:true});
const report={date:new Date().toISOString(),root,checks:[],modelRequests:[],isolation:{realSessionsUsed:false,realCredentialsUsed:false,realInferenceUsed:false,desktopPackageModified:false,backendReplaced:false,sharedServerConfigured:false}};
const children=[],ownedPids=new Set();let browser,page,desktop,server,queueTimer,manageBrowser,managePage,manageOrigin,cleaning=false;
let finishManage;
const manageCompletionGate=new Promise(resolve=>{finishManage=resolve;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const processes=()=>execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],ppid:+m[2],command:m[3]}:null;}).filter(Boolean);
const initial=processes(),initialPids=new Set(initial.map(p=>p.pid));
report.protectedProcesses=initial.filter(p=>p.command===desktopBinary||(p.command.startsWith(app+'/')&&p.command.includes('app-server')));
const env={...process.env,CODEX_HOME:home,CODEX_ELECTRON_USER_DATA_PATH:profile,CODEX_ELECTRON_START_IN_BACKGROUND:'1',CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH:'1'};
for(const key of['OPENAI_API_KEY','CODEX_API_KEY','CODEX_CLI_PATH','CODEX_APP_SERVER_FORCE_CLI','CODEX_APP_SERVER_WS_URL','CODEX_APP_SERVER_USE_LOCAL_DAEMON','CODEX_APP_TOOLS_PIPE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
function launch(command,args,name,extraEnv={}){const c=spawn(command,args,{cwd:workspace,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});children.push(c);ownedPids.add(c.pid);const out=createWriteStream(join(root,name+'.log'));c.stdout.pipe(out,{end:false});c.stderr.pipe(out,{end:false});c.once('exit',()=>out.end());c.on('error',e=>out.write(String(e)));return c;}
function check(id,pass,evidence={}){const c={id,outcome:pass?'pass':'fail',evidence};report.checks.push(c);if(!pass)process.exitCode=1;console.log(JSON.stringify(c));}
async function poll(fn,timeout=30000){const until=Date.now()+timeout;let value;while(Date.now()<until){try{value=await fn();if(value)return value;}catch{}await pause(150);}throw Error('Timed out; last='+JSON.stringify(value));}
async function files(p){let result=[];for(const e of await readdir(p,{withFileTypes:true}).catch(()=>[])){const q=join(p,e.name);if(e.isDirectory())result.push(...await files(q));else result.push(q);}return result;}
async function sendDesktop(marker){await page.locator('[contenteditable="true"]').first().fill(marker);await page.getByRole('button',{name:/^(发送|Send|Send message)$/}).click({timeout:90000,noWaitAfter:true});}
async function reply(marker,timeout=45000){await page.getByText('Local stub completed '+marker,{exact:true}).waitFor({timeout});}
async function startManage(threadId){
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 manageOrigin='http://127.0.0.1:'+port;
 launch(process.execPath,[join(repo,'dist/server/index.js')],'manage',{NODE_ENV:'production',CODEX_CLI_PATH:cli,CODEX_SESSIONS_DIR:join(home,'sessions'),CODEX_WEB_PORT:String(port),CODEX_WEB_HOST:'127.0.0.1',CODEX_WEB_PASSWORD:'test-handoff',CODEX_WEB_CLIENT_DIR:join(repo,'dist/client'),CODEX_MANAGE_METADATA_FILE:join(root,'metadata.json'),CODEX_MANAGE_COLLABORATION_FILE:join(root,'collaboration.json')});
 await poll(async()=>{const r=await fetch(manageOrigin+'/api/me');return r.ok;},30000);
 manageBrowser=await chromium.launch({headless:true,channel:'chrome'});managePage=await manageBrowser.newPage({viewport:{width:1200,height:900}});
 await managePage.goto(manageOrigin);await managePage.getByLabel('密码',{exact:true}).fill('test-handoff');const loggedIn=managePage.waitForResponse(r=>r.url().endsWith('/api/login'));await managePage.getByRole('button',{name:'登录',exact:true}).click();await loggedIn;
 await managePage.goto(manageOrigin+'/'+threadId);await managePage.getByLabel('发送给 Codex 的消息').waitFor();
}
async function queueMessage(threadId,marker){
 const start=Date.now(),responsePromise=managePage.waitForResponse(r=>r.url().endsWith('/api/sessions/'+threadId+'/input')&&r.request().method()==='POST');
 await managePage.getByLabel('发送给 Codex 的消息').fill(marker);await managePage.getByRole('button',{name:'发送消息',exact:true}).click();
 const response=await responsePromise,body=await response.json();
 check('manage-ui-enqueues-'+marker,response.status()===202&&body.runtime?.executionSource==='external_queue',{status:response.status(),runtime:body.runtime});
 return {code:response.status()===202?0:1,start,output:JSON.stringify(body),runtime:body.runtime};
}

function collectOwned(){const ps=processes();let change=true;while(change){change=false;for(const p of ps)if(!initialPids.has(p.pid)&&!ownedPids.has(p.pid)&&ownedPids.has(p.ppid)){ownedPids.add(p.pid);change=true;}}
 // An auto-started daemon can reparent itself. Match only new Codex processes with this test home.
 for(const p of ps)if(!initialPids.has(p.pid)&&p.command.startsWith(app+'/')){if(p.command.includes(root))ownedPids.add(p.pid);else if(p.command.includes('codex')){try{const detail=execFileSync('ps',['eww','-p',String(p.pid),'-o','command='],{encoding:'utf8'});if(detail.includes('CODEX_HOME='+home))ownedPids.add(p.pid);}catch{}}}
 return ps.filter(p=>ownedPids.has(p.pid));}
async function cleanup(){if(cleaning)return;cleaning=true;clearInterval(queueTimer);try{await manageBrowser?.close();}catch{}try{await browser?.close();}catch{}collectOwned();for(const c of [...children].reverse())if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');await pause(600);for(const pid of ownedPids)if(pid!==process.pid)try{process.kill(pid,'SIGTERM');}catch{}server?.closeAllConnections();server?.close();const after=processes();check('real-desktop-preserved',report.protectedProcesses.filter(p=>p.command===desktopBinary||initial.some(parent=>parent.pid===p.ppid&&parent.command===desktopBinary)).every(p=>after.some(n=>n.pid===p.pid)),{pids:report.protectedProcesses.map(p=>p.pid)});report.summary=Object.fromEntries(['pass','fail'].map(k=>[k,report.checks.filter(c=>c.outcome===k).length]));await writeFile(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,summary:report.summary}));}
process.once('SIGINT',()=>cleanup().then(()=>process.exit(130)));process.once('SIGTERM',()=>cleanup().then(()=>process.exit(143)));
try{
 report.versions={desktop:execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim(),cli:execFileSync(cli,['--version'],{encoding:'utf8'}).trim()};
 server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"object":"list","data":[]}');return;}let body;try{body=JSON.parse(raw||'{}');}catch{body={};}const users=(body.input||[]).filter(x=>x.role==='user'),marker=JSON.stringify(users.at(-1)||{}).match(/DEX-[A-Z0-9-]+/)?.[0]||'DEX-REPLY';report.modelRequests.push({at:Date.now(),path:req.url,marker,previousMarkers:[...new Set([...JSON.stringify(users).matchAll(/DEX-[A-Z0-9-]+/g)].map(m=>m[0]))],assistantMarkers:[...new Set([...JSON.stringify((body.input||[]).filter(x=>x.role==='assistant')).matchAll(/DEX-[A-Z0-9-]+/g)].map(m=>m[0]))]});const n=report.modelRequests.length,text='Local stub completed '+marker,item={id:'msg_dex_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},response={id:'resp_dex_'+n,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'research-local-stub',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const send=(type,rest)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...rest})+'\n\n');send('response.created',{response:{...response,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});if(marker==='DEX-MANAGE-START')await manageCompletionGate;if(marker.includes('SLOW'))await pause(8000);send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:text});send('response.output_item.done',{output_index:0,item});send('response.completed',{response});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(home,'config.toml'),`check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Native desktop continuation local stub"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
 await writeFile(join(home,'auth.json'),'{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
 await writeFile(join(home,'.codex-global-state.json'),JSON.stringify({'electron-workspace-roots':[workspace],'electron-saved-workspace-roots':[workspace],'active-workspace-roots':[workspace],'electron-workspace-root-labels':{[workspace]:'Native Desktop Continuation Research'}}));
 const desktopArgs=['--user-data-dir='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'];
 desktop=launch(desktopBinary,desktopArgs,'desktop');queueTimer=setInterval(()=>{try{collectOwned();}catch{}},1000);
 const port=await poll(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),40000);
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:90000});
 // The desktop also exposes an app: splash page; select the actual conversation surface.
 page=await poll(async()=>{for(const candidate of browser.contexts()[0]?.pages()||[]){if(candidate.url().startsWith('app:')&&await candidate.locator('[contenteditable="true"]').count())return candidate;}return false;},90000);page.setDefaultTimeout(90000);
 report.desktopPageUrl=page.url();
 await page.addLocatorHandler(page.getByRole('button',{name:'继续使用当前模型',exact:true}),async locator=>locator.click());
 await poll(async()=>await page.locator('[contenteditable="true"]').count());await pause(2500);
 report.desktopPid=desktop.pid;report.desktopBackend=await poll(()=>collectOwned().find(p=>p.ppid===desktop.pid&&p.command.includes('app-server')));
 check('normal-private-backend',!report.desktopBackend.command.includes('--listen')&&!env.CODEX_APP_SERVER_WS_URL&&!env.CODEX_CLI_PATH,{backend:report.desktopBackend});
 await sendDesktop('DEX-DESKTOP-ONE');await reply('DEX-DESKTOP-ONE',90000);
 const session=await poll(async()=>{for(const f of await files(join(home,'sessions'))){if(!f.endsWith('.jsonl'))continue;const raw=await readFile(f,'utf8');if(!raw.includes('DEX-DESKTOP-ONE'))continue;const meta=raw.split('\n').map(l=>{try{return JSON.parse(l);}catch{return {};}}).find(x=>x.type==='session_meta');if(meta?.payload?.id)return {path:f,id:meta.payload.id};}return false;});
 report.threadId=session.id;check('desktop-existing-thread',true,session);await page.screenshot({path:join(output,'desktop-before-queue.png')});
 report.beforeQueue={processes:collectOwned(),controlSocketExists:existsSync(join(home,'app-server-control/app-server-control.sock'))};
 await startManage(session.id);
 report.queue=await queueMessage(session.id,'DEX-EXTERNAL-QUEUE');
 let queueCompleted=false;try{await reply('DEX-EXTERNAL-QUEUE');queueCompleted=true;}catch{}
 report.queue={...report.queue,replyObservedAfterMs:Date.now()-report.queue.start,afterProcesses:collectOwned().filter(p=>p.command.startsWith(app+'/')&&p.command.includes(' app-server')),controlSocketExists:existsSync(join(home,'app-server-control/app-server-control.sock'))};
 const queueReply=await page.getByText('Local stub completed DEX-EXTERNAL-QUEUE',{exact:true}).count();
 check('native-queue-continues-desktop-thread',report.queue.code===0&&queueCompleted&&queueReply>0&&report.modelRequests.some(r=>r.marker==='DEX-EXTERNAL-QUEUE'),{code:report.queue.code,output:report.queue.output,desktopReplyCount:queueReply,replyObservedAfterMs:report.queue.replyObservedAfterMs,modelRequests:report.modelRequests});
 check('queue-reuses-desktop-backend',report.queue.afterProcesses.some(p=>p.pid===report.desktopBackend.pid),{processes:report.queue.afterProcesses,controlSocketExists:report.queue.controlSocketExists});
 await page.screenshot({path:join(output,'desktop-after-queue.png')});
 await sendDesktop('DEX-DESKTOP-THREE');await reply('DEX-DESKTOP-THREE');
 const next=report.modelRequests.find(r=>r.marker==='DEX-DESKTOP-THREE');
 check('desktop-continues-after-external-message',next?.previousMarkers.includes('DEX-EXTERNAL-QUEUE')&&next?.assistantMarkers.includes('DEX-EXTERNAL-QUEUE'),next);
 await sendDesktop('DEX-DESKTOP-SLOW');await poll(()=>report.modelRequests.find(r=>r.marker==='DEX-DESKTOP-SLOW'));
 report.busyQueue=await queueMessage(session.id,'DEX-EXTERNAL-AFTER-BUSY');
 await reply('DEX-DESKTOP-SLOW');await reply('DEX-EXTERNAL-AFTER-BUSY');
 const busy=report.modelRequests.find(r=>r.marker==='DEX-EXTERNAL-AFTER-BUSY');
 check('queue-during-active-desktop-turn',report.busyQueue.code===0&&busy?.previousMarkers.includes('DEX-DESKTOP-SLOW')&&busy?.assistantMarkers.includes('DEX-DESKTOP-SLOW'),{code:report.busyQueue.code,output:report.busyQueue.output,request:busy});
 await managePage.getByText('Local stub completed DEX-EXTERNAL-AFTER-BUSY',{exact:true}).waitFor({timeout:30000});
 const completedDeliveries=await poll(async()=>{const r=await managePage.request.get(manageOrigin+'/api/sessions/'+session.id+'/runtime');const b=await r.json();return b.runtime?.deliveries?.length===2&&b.runtime.deliveries.every(row=>row.status==='completed')?b.runtime.deliveries:false;},20000);
 check('delivery-completion-correlated-with-persisted-turns',true,{deliveries:completedDeliveries});
 check('desktop-messages-auto-sync-to-manage',await managePage.getByText('Local stub completed DEX-DESKTOP-THREE',{exact:true}).count()===1);
 await managePage.screenshot({path:join(output,'manage-final.png')});
 await writeFile(join(output,'manage-final.txt'),await managePage.locator('body').innerText());
 const final=await readFile(session.path,'utf8'),records=final.trim().split('\n').map(l=>JSON.parse(l)),messages=records.filter(r=>r.type==='response_item'&&r.payload?.type==='message').map(r=>({role:r.payload.role,text:(r.payload.content||[]).map(c=>c.text||'').join('').trim()})),counts={};
 // The initial prompt is also the sidebar/title label; count durable messages instead of every matching UI label.
 for(const marker of['DEX-DESKTOP-ONE','DEX-EXTERNAL-QUEUE','DEX-DESKTOP-THREE','DEX-DESKTOP-SLOW','DEX-EXTERNAL-AFTER-BUSY'])counts[marker]={user:messages.filter(m=>m.role==='user'&&m.text===marker).length,assistant:messages.filter(m=>m.role==='assistant'&&m.text==='Local stub completed '+marker).length};
 check('same-thread-and-no-duplicates',Object.values(counts).every(c=>c.user===1&&c.assistant===1),{threadId:session.id,counts});
 await writeFile(join(output,'thread-messages.json'),JSON.stringify(messages.filter(message=>/^DEX-[A-Z0-9-]+$/.test(message.text)||/^Local stub completed DEX-[A-Z0-9-]+$/.test(message.text)),null,2));
 await page.screenshot({path:join(output,'desktop-final.png')});
 await writeFile(join(output,'desktop-final.txt'),await page.locator('body').innerText());
 await writeFile(join(output,'queue-output.txt'),report.queue.output);
 const created=await managePage.request.post(manageOrigin+'/api/sessions',{data:{cwd:workspace}});const managedId=(await created.json()).threadId;
 await pause(1500);
 const beforeFirstInput=await managePage.request.get(manageOrigin+'/api/sessions/'+managedId+'/runtime');
 check('new-thread-not-discarded-before-first-input',(await beforeFirstInput.json()).runtime?.leaseStatus!=='released',{managedId});
 const posted=await managePage.request.post(manageOrigin+'/api/sessions/'+managedId+'/input',{data:{text:'DEX-MANAGE-START',clientRequestId:'handoff-research-manage-first'}});
 const postedBody=await posted.json();
 check('manage-starts-original-thread',posted.ok(),{managedId,status:posted.status(),body:postedBody});
 if(!posted.ok())throw Error('Manage first input failed: '+JSON.stringify(postedBody));
 await poll(()=>report.modelRequests.find(row=>row.marker==='DEX-MANAGE-START'));
 await page.reload();await pause(2000);
 await page.getByText('DEX-MANAGE-START',{exact:true}).first().click();
 const conflict=await poll(async()=>{const log=await readFile(join(root,'desktop.log'),'utf8');return log.includes('active writer')&&log.includes(managedId);},30000);
 check('desktop-reports-active-writer-while-manage-runs',Boolean(conflict),{managedId});
 await page.screenshot({path:join(output,'desktop-handoff-conflict.png')});
 await writeFile(join(output,'desktop-handoff-conflict.txt'),await page.locator('body').innerText());
 finishManage();
 const released=await poll(async()=>{const r=await managePage.request.get(manageOrigin+'/api/sessions/'+managedId+'/runtime');const b=await r.json();return b.runtime?.leaseStatus==='released'?b.runtime:false;},20000);
 check('manage-auto-releases-original-thread',released.status==='history',{managedId,runtime:released});
 const automaticallyRetried=await page.getByText('Local stub completed DEX-MANAGE-START',{exact:true}).waitFor({timeout:10000}).then(()=>true,()=>false);
 report.desktopRecovery={automaticallyRetried,reopenRequired:!automaticallyRetried};
 if(!automaticallyRetried){await page.reload();await pause(2000);await page.getByText('DEX-MANAGE-START',{exact:true}).first().click();}
 await page.getByText('Local stub completed DEX-MANAGE-START',{exact:true}).waitFor({timeout:30000});
 report.handoffDesktopUrl=page.url();
 await page.screenshot({path:join(output,'desktop-handoff-before.png')});
 await sendDesktop('DEX-DESKTOP-AFTER-MANAGE');await reply('DEX-DESKTOP-AFTER-MANAGE');
 const handoff=report.modelRequests.find(r=>r.marker==='DEX-DESKTOP-AFTER-MANAGE');
 check('desktop-continues-manage-original-with-context',handoff?.previousMarkers.includes('DEX-MANAGE-START')&&handoff?.assistantMarkers.includes('DEX-MANAGE-START'),{managedId,request:handoff});
 await page.screenshot({path:join(output,'desktop-handoff-final.png')});

}catch(e){report.fatal=String(e.stack||e);console.error(report.fatal);process.exitCode=1;try{if(managePage){await managePage.screenshot({path:join(output,'manage-fatal.png')});await writeFile(join(output,'manage-fatal.txt'),await managePage.locator('body').innerText());}if(page){await page.screenshot({path:join(output,'fatal.png')});await writeFile(join(output,'fatal.txt'),await page.locator('body').innerText());}}catch{}}
finally{await cleanup();process.exit(process.exitCode||0);}
