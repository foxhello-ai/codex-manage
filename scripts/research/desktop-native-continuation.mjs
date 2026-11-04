#!/usr/bin/env node
/** Verify existing desktop continuation interfaces without replacing its backend. */
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
const root=await mkdtemp('/tmp/cdn-'),home=join(root,'home'),profile=join(root,'profile'),workspace=join(root,'workspace');
const output=resolve(process.env.RESEARCH_REPORT_DIR||join(root,'evidence'));
for(const p of[home,profile,workspace,output])await mkdir(p,{recursive:true});
const report={date:new Date().toISOString(),root,checks:[],modelRequests:[],isolation:{realSessionsUsed:false,realCredentialsUsed:false,realInferenceUsed:false,desktopPackageModified:false,backendReplaced:false,sharedServerConfigured:false}};
const children=[],ownedPids=new Set();let browser,page,desktop,server,queueTimer,cleaning=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const processes=()=>execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],ppid:+m[2],command:m[3]}:null;}).filter(Boolean);
const initial=processes(),initialPids=new Set(initial.map(p=>p.pid));
report.protectedProcesses=initial.filter(p=>p.command===desktopBinary||(p.command.startsWith(app+'/')&&p.command.includes('app-server')));
const env={...process.env,CODEX_HOME:home,CODEX_ELECTRON_USER_DATA_PATH:profile,CODEX_ELECTRON_START_IN_BACKGROUND:'1',CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH:'1'};
for(const key of['OPENAI_API_KEY','CODEX_API_KEY','CODEX_CLI_PATH','CODEX_APP_SERVER_FORCE_CLI','CODEX_APP_SERVER_WS_URL','CODEX_APP_SERVER_USE_LOCAL_DAEMON','CODEX_APP_TOOLS_PIPE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
function launch(command,args,name){const c=spawn(command,args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});children.push(c);ownedPids.add(c.pid);const out=createWriteStream(join(root,name+'.log'));c.stdout.pipe(out,{end:false});c.stderr.pipe(out,{end:false});c.once('exit',()=>out.end());c.on('error',e=>out.write(String(e)));return c;}
function check(id,pass,evidence={}){const c={id,outcome:pass?'pass':'fail',evidence};report.checks.push(c);console.log(JSON.stringify(c));}
async function poll(fn,timeout=30000){const until=Date.now()+timeout;let value;while(Date.now()<until){try{value=await fn();if(value)return value;}catch{}await pause(150);}throw Error('Timed out; last='+JSON.stringify(value));}
async function files(p){let result=[];for(const e of await readdir(p,{withFileTypes:true}).catch(()=>[])){const q=join(p,e.name);if(e.isDirectory())result.push(...await files(q));else result.push(q);}return result;}
async function sendDesktop(marker){await page.locator('[contenteditable="true"]').first().fill(marker);await page.getByRole('button',{name:/^(发送|Send|Send message)$/}).click();}
async function reply(marker,timeout=45000){await page.getByText('Local stub completed '+marker,{exact:true}).waitFor({timeout});}
async function queueMessage(threadId,marker){const args=['queue','--thread',threadId,'--message',marker,'-C',workspace],start=Date.now(),child=launch(cli,args,marker);const exit=await Promise.race([new Promise(r=>child.once('exit',(code,signal)=>r({code,signal}))),pause(30000).then(()=>({timeout:true}))]);if(exit.timeout)child.kill('SIGTERM');const output=await readFile(join(root,marker+'.log'),'utf8');return {args,pid:child.pid,start,...exit,output};}
function collectOwned(){const ps=processes();let change=true;while(change){change=false;for(const p of ps)if(!initialPids.has(p.pid)&&!ownedPids.has(p.pid)&&ownedPids.has(p.ppid)){ownedPids.add(p.pid);change=true;}}
 // An auto-started daemon can reparent itself. Match only new Codex processes with this test home.
 for(const p of ps)if(!initialPids.has(p.pid)&&p.command.startsWith(app+'/')){if(p.command.includes(root))ownedPids.add(p.pid);else if(p.command.includes('codex')){try{const detail=execFileSync('ps',['eww','-p',String(p.pid),'-o','command='],{encoding:'utf8'});if(detail.includes('CODEX_HOME='+home))ownedPids.add(p.pid);}catch{}}}
 return ps.filter(p=>ownedPids.has(p.pid));}
async function cleanup(){if(cleaning)return;cleaning=true;clearInterval(queueTimer);try{await browser?.close();}catch{}collectOwned();for(const c of [...children].reverse())if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');await pause(600);for(const pid of ownedPids)if(pid!==process.pid)try{process.kill(pid,'SIGTERM');}catch{}server?.closeAllConnections();server?.close();const after=processes();check('real-desktop-preserved',report.protectedProcesses.every(p=>after.some(n=>n.pid===p.pid)),{pids:report.protectedProcesses.map(p=>p.pid)});report.summary=Object.fromEntries(['pass','fail'].map(k=>[k,report.checks.filter(c=>c.outcome===k).length]));await writeFile(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,summary:report.summary}));}
process.once('SIGINT',()=>cleanup().then(()=>process.exit(130)));process.once('SIGTERM',()=>cleanup().then(()=>process.exit(143)));
try{
 report.versions={desktop:execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim(),cli:execFileSync(cli,['--version'],{encoding:'utf8'}).trim()};
 server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"object":"list","data":[]}');return;}let body;try{body=JSON.parse(raw||'{}');}catch{body={};}const users=(body.input||[]).filter(x=>x.role==='user'),marker=JSON.stringify(users.at(-1)||{}).match(/DEX-[A-Z0-9-]+/)?.[0]||'DEX-REPLY';report.modelRequests.push({at:Date.now(),path:req.url,marker,previousMarkers:[...new Set([...JSON.stringify(users).matchAll(/DEX-[A-Z0-9-]+/g)].map(m=>m[0]))],assistantMarkers:[...new Set([...JSON.stringify((body.input||[]).filter(x=>x.role==='assistant')).matchAll(/DEX-[A-Z0-9-]+/g)].map(m=>m[0]))]});const n=report.modelRequests.length,text='Local stub completed '+marker,item={id:'msg_dex_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},response={id:'resp_dex_'+n,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'research-local-stub',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const send=(type,rest)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...rest})+'\n\n');send('response.created',{response:{...response,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});if(marker.includes('SLOW'))await pause(8000);send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:text});send('response.output_item.done',{output_index:0,item});send('response.completed',{response});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(home,'config.toml'),`check_for_update_on_startup = false\nmodel = "research-local-stub"\nmodel_provider = "research"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.research]\nname = "Native desktop continuation local stub"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
 await writeFile(join(home,'auth.json'),'{"OPENAI_API_KEY":"local-research-placeholder-not-a-real-key"}');
 await writeFile(join(home,'.codex-global-state.json'),JSON.stringify({'electron-workspace-roots':[workspace],'electron-saved-workspace-roots':[workspace],'active-workspace-roots':[workspace],'electron-workspace-root-labels':{[workspace]:'Native Desktop Continuation Research'}}));
 const desktopArgs=['--user-data-dir='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'];
 desktop=launch(desktopBinary,desktopArgs,'desktop');queueTimer=setInterval(()=>{try{collectOwned();}catch{}},1000);
 const port=await poll(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),40000);
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=await poll(()=>browser.contexts()[0]?.pages().find(p=>p.url().startsWith('app:')));
 await page.addLocatorHandler(page.getByRole('button',{name:'继续使用当前模型',exact:true}),async locator=>locator.click());
 await poll(async()=>await page.locator('[contenteditable="true"]').count());await pause(2500);
 report.desktopPid=desktop.pid;report.desktopBackend=await poll(()=>collectOwned().find(p=>p.ppid===desktop.pid&&p.command.includes('app-server')));
 check('normal-private-backend',!report.desktopBackend.command.includes('--listen')&&!env.CODEX_APP_SERVER_WS_URL&&!env.CODEX_CLI_PATH,{backend:report.desktopBackend});
 await sendDesktop('DEX-DESKTOP-ONE');await reply('DEX-DESKTOP-ONE',90000);
 const session=await poll(async()=>{for(const f of await files(join(home,'sessions'))){if(!f.endsWith('.jsonl'))continue;const raw=await readFile(f,'utf8');if(!raw.includes('DEX-DESKTOP-ONE'))continue;const meta=raw.split('\n').map(l=>{try{return JSON.parse(l);}catch{return {};}}).find(x=>x.type==='session_meta');if(meta?.payload?.id)return {path:f,id:meta.payload.id};}return false;});
 report.threadId=session.id;check('desktop-existing-thread',true,session);await page.screenshot({path:join(output,'desktop-before-queue.png')});
 report.beforeQueue={processes:collectOwned(),controlSocketExists:existsSync(join(home,'app-server-control/app-server-control.sock'))};
 report.queue=await queueMessage(session.id,'DEX-EXTERNAL-QUEUE');
 let queueCompleted=false;try{await reply('DEX-EXTERNAL-QUEUE');queueCompleted=true;}catch{}
 report.queue={...report.queue,replyObservedAfterMs:Date.now()-report.queue.start,afterProcesses:collectOwned().filter(p=>p.command.startsWith(app+'/')&&p.command.includes(' app-server')),controlSocketExists:existsSync(join(home,'app-server-control/app-server-control.sock'))};
 const queueReply=await page.getByText('Local stub completed DEX-EXTERNAL-QUEUE',{exact:true}).count();
 check('native-queue-continues-desktop-thread',report.queue.code===0&&queueCompleted&&queueReply>0&&report.modelRequests.some(r=>r.marker==='DEX-EXTERNAL-QUEUE'),{code:report.queue.code,output:report.queue.output,desktopReplyCount:queueReply,replyObservedAfterMs:report.queue.replyObservedAfterMs,modelRequests:report.modelRequests});
 check('queue-reuses-desktop-backend',report.queue.afterProcesses.length===1&&report.queue.afterProcesses[0].pid===report.desktopBackend.pid,{processes:report.queue.afterProcesses,controlSocketExists:report.queue.controlSocketExists});
 await page.screenshot({path:join(output,'desktop-after-queue.png')});
 await sendDesktop('DEX-DESKTOP-THREE');await reply('DEX-DESKTOP-THREE');
 const next=report.modelRequests.find(r=>r.marker==='DEX-DESKTOP-THREE');
 check('desktop-continues-after-external-message',next?.previousMarkers.includes('DEX-EXTERNAL-QUEUE')&&next?.assistantMarkers.includes('DEX-EXTERNAL-QUEUE'),next);
 await sendDesktop('DEX-DESKTOP-SLOW');await poll(()=>report.modelRequests.find(r=>r.marker==='DEX-DESKTOP-SLOW'));
 report.busyQueue=await queueMessage(session.id,'DEX-EXTERNAL-AFTER-BUSY');
 await reply('DEX-DESKTOP-SLOW');await reply('DEX-EXTERNAL-AFTER-BUSY');
 const busy=report.modelRequests.find(r=>r.marker==='DEX-EXTERNAL-AFTER-BUSY');
 check('queue-during-active-desktop-turn',report.busyQueue.code===0&&busy?.previousMarkers.includes('DEX-DESKTOP-SLOW')&&busy?.assistantMarkers.includes('DEX-DESKTOP-SLOW'),{code:report.busyQueue.code,output:report.busyQueue.output,request:busy});
 const final=await readFile(session.path,'utf8'),records=final.trim().split('\n').map(l=>JSON.parse(l)),messages=records.filter(r=>r.type==='response_item'&&r.payload?.type==='message').map(r=>({role:r.payload.role,text:(r.payload.content||[]).map(c=>c.text||'').join('').trim()})),counts={};
 // The initial prompt is also the sidebar/title label; count durable messages instead of every matching UI label.
 for(const marker of['DEX-DESKTOP-ONE','DEX-EXTERNAL-QUEUE','DEX-DESKTOP-THREE','DEX-DESKTOP-SLOW','DEX-EXTERNAL-AFTER-BUSY'])counts[marker]={user:messages.filter(m=>m.role==='user'&&m.text===marker).length,assistant:messages.filter(m=>m.role==='assistant'&&m.text==='Local stub completed '+marker).length};
 check('same-thread-and-no-duplicates',Object.values(counts).every(c=>c.user===1&&c.assistant===1),{threadId:session.id,counts});
 await writeFile(join(output,'thread-records.jsonl'),final);
 await page.screenshot({path:join(output,'desktop-final.png')});
 await writeFile(join(output,'desktop-final.txt'),await page.locator('body').innerText());
 await writeFile(join(output,'queue-output.txt'),report.queue.output);
}catch(e){report.fatal=String(e.stack||e);console.error(report.fatal);process.exitCode=1;try{if(page){await page.screenshot({path:join(output,'fatal.png')});await writeFile(join(output,'fatal.txt'),await page.locator('body').innerText());}}catch{}}
finally{await cleanup();process.exit(process.exitCode||0);}
