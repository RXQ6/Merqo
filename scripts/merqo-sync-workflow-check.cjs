// Real isolated Electron, SQLite worker and encrypted credential backend. Synthetic platform data only.
const {_electron:electron}=require(process.env.MERQO_PLAYWRIGHT_MODULE||'playwright');
const {expect}=require((process.env.MERQO_PLAYWRIGHT_MODULE||'playwright')+'/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(root,'.runtime/sync-ui-')),out=path.join(root,'artifacts/sync-workflow',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});let app,page;const checks=[];
const button=name=>page.getByRole('button',{name,exact:true});
async function request(input){const r=await page.evaluate(input=>window.electronAPI.retailRequest(input),input);assert(r.ok,r.error);return r;}
async function view(){const r=await request({op:'sync_view'});assert.equal(r.kind,'sync');return r.data;}
async function launch(){
 const env={...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config'),RETAILPILOT_USER_DATA_DIR:path.join(profile,'chromium'),RETAILPILOT_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/electron')],cwd:root,env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(30000);await page.context().tracing.start({screenshots:true,snapshots:true});
 await expect.poll(async()=>await page.getByRole('button',{name:/^(Get Started|开始使用|Setup later|稍后设置|仅使用经营分析)$/}).count()||await page.locator('[data-focus-zone="sidebar"]').count(),{timeout:30000}).toBeGreaterThan(0);
 for(const name of [/^仅使用经营分析$/,/^(Get Started|开始使用)$/,/^(Setup later|稍后设置)$/]){const b=page.getByRole('button',{name});if(await b.count())await b.click();}
 await expect.poll(async()=>await page.getByTestId('retail-workspace').isVisible()||await button('经营分析').isVisible(),{timeout:30000}).toBe(true);if(!await page.getByTestId('retail-workspace').isVisible())await button('经营分析').click();await button('平台接入').click();await expect(page.getByRole('region',{name:'抖店接入配置向导'})).toBeVisible();
}
async function close(name){await page.context().tracing.stop({path:path.join(out,name)});await app.close();app=null;}
async function configure(scenario){
 await button('1. 配置连接').click();await page.getByLabel('演练场景',{exact:true}).selectOption(scenario);await button('保存并下一步').click();await button('检测只读连接').click();await expect(page.getByRole('status').filter({hasText:'演练检查通过'})).toBeVisible();await button('下一步：同步范围').click();
}
async function create(size=2){const prior=(await view()).jobs.length;await page.getByLabel('每页条数',{exact:true}).fill(String(size));await button('开始演练拉取').click();await expect.poll(async()=>(await view()).jobs.length,{timeout:30000}).toBeGreaterThan(prior);return(await view()).jobs[0];}
async function main(){
 if(process.argv.includes('--preview')){
  await launch();await configure('normal');await page.screenshot({path:path.join(out,'wizard.png'),fullPage:true});const job=await create(2);
  await expect.poll(async()=>(await view()).jobs.find(j=>j.id===job.id).status,{timeout:60000}).toBe('fetched');
  await expect(page.getByRole('article',{name:`同步任务 ${job.id}`})).toContainText('拉取结束');
  await page.screenshot({path:path.join(out,'tasks.png'),fullPage:true});await close('preview.zip');
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,preview:true,syntheticOnly:true,realPlatformCalls:0},null,2));console.log(JSON.stringify({ok:true,out,preview:true}));return;
 }
 await launch();await configure('normal');const first=await create(1);
 await expect.poll(async()=>(await view()).jobs.find(j=>j.id===first.id).nextPage,{timeout:30000}).toBeGreaterThan(0);
 const firstPanel=page.getByRole('article',{name:`同步任务 ${first.id}`});await firstPanel.getByRole('button',{name:'暂停任务',exact:true}).click();
 await expect(firstPanel).toContainText('已暂停');let paused=(await view()).jobs.find(j=>j.id===first.id);assert(paused.nextPage>0&&paused.nextPage<7);const pausedPage=paused.nextPage;
 await firstPanel.getByRole('button',{name:'从断点继续',exact:true}).click();
 await expect.poll(async()=>(await view()).jobs.find(j=>j.id===first.id).nextPage,{timeout:30000}).toBeGreaterThan(pausedPage);
 await close('before-restart.zip');await launch();
 let recovered=(await view()).jobs.find(j=>j.id===first.id);assert(recovered.nextPage>=pausedPage);assert.equal(recovered.status,'paused');
 checks.push('wizard config and readonly fixture check start a durable task; pause/resume and actual running-process restart preserve the committed checkpoint');
 await page.getByRole('article',{name:`同步任务 ${first.id}`}).getByRole('button',{name:'从断点继续',exact:true}).click();
 await expect.poll(async()=>(await view()).jobs.find(j=>j.id===first.id).status,{timeout:60000}).toBe('fetched');
 const finished=(await view()).jobs.find(j=>j.id===first.id);assert.equal(finished.received,7);assert.equal(finished.nextPage,7);assert.equal((await view()).receipts[first.id].length,7);
 await expect(page.getByRole('article',{name:`同步任务 ${first.id}`})).toContainText('字段映射、业务校验、确认入库、对账均未完成');
 const snap=await request({op:'snapshot',source:'csv',limit:30});assert.equal(snap.data.pagination.total,0);
 checks.push('resume finishes seven unique committed pages and seven staged rows; unmapped data does not enter CSV business metrics');
 await configure('invalid_response');const bad=await create();await expect.poll(async()=>(await view()).jobs.find(j=>j.id===bad.id).status,{timeout:60000}).toBe('failed');
 const before=(await view()).jobs.find(j=>j.id===bad.id);assert.equal(before.nextPage,1);assert.equal(before.received,2);
 const badPanel=page.getByRole('article',{name:`同步任务 ${bad.id}`});await badPanel.getByRole('button',{name:'重试当前页',exact:true}).click();
 await expect.poll(async()=>{const j=(await view()).jobs.find(j=>j.id===bad.id);return j.epoch>before.epoch&&j.status==='failed';},{timeout:30000}).toBe(true);
 assert.equal((await view()).receipts[bad.id].length,1);assert.equal((await view()).jobs.find(j=>j.id===bad.id).received,2);
 checks.push('invalid responses stop without checkpoint advance; explicit retry repeats only the failed page without duplicate staging');
 await configure('rate_limit');const rate=await create();await expect.poll(async()=>(await view()).jobs.find(j=>j.id===rate.id).status,{timeout:30000}).toBe('retry_wait');
 await expect.poll(async()=>(await view()).jobs.find(j=>j.id===rate.id).status,{timeout:60000}).toBe('fetched');assert.equal((await view()).receipts[rate.id].length,4);
 checks.push('HTTP 429 fixture automatically retries the same page with bounded backoff and then completes');
 await page.screenshot({path:path.join(out,'sync-tasks.png'),fullPage:true});
 await button('1. 配置连接').click();await page.getByLabel('运行模式',{exact:true}).selectOption('live');await page.getByLabel('店铺 ID',{exact:true}).fill('fixture-shop');await page.getByLabel('App Key',{exact:true}).fill('fixture-app');await page.getByLabel('App Secret',{exact:true}).fill('synthetic-ui-secret');await page.getByLabel('Access Token',{exact:true}).fill('synthetic-ui-token');
 const future=new Date(Date.now()+86400000);await page.getByLabel('授权到期时间',{exact:true}).fill(new Date(future.getTime()-future.getTimezoneOffset()*60000).toISOString().slice(0,16));await button('保存并下一步').click();
 const live=await view();assert.equal(live.connection.mode,'live');assert(!JSON.stringify(live).includes('synthetic-ui-secret'));assert(!JSON.stringify(live).includes('synthetic-ui-token'));
 const blocked=await page.evaluate(revision=>window.electronAPI.retailRequest({op:'sync_create',expectedRevision:revision,window:{start:Math.floor(Date.now()/1000)-3600,end:Math.floor(Date.now()/1000)-60,size:2}}),live.connection.revision);assert.equal(blocked.ok,false);assert(blocked.error.includes('连接检查'));
 const forged=await page.evaluate(()=>window.electronAPI.retailRequest({op:'sync_store_page',id:crypto.randomUUID(),expectedEpoch:0,page:0,count:1,reportedTotal:1,encrypted:'plaintext',responseSha256:'a'.repeat(64)}));assert.equal(forged.ok,false);
 const cfg=JSON.parse(fs.readFileSync(path.join(profile,'config/config.json'),'utf8')),workspace=cfg.workspaces[0],db=path.join(workspace.rootPath,'retail/operations.sqlite.sync.sqlite');
 const verify=`import {Database} from 'bun:sqlite';import {getCredentialManager} from './packages/shared/src/credentials/manager.ts';import {createDecipheriv} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';import assert from 'node:assert/strict';const [file,ws,job,ref]=Bun.argv.slice(-4);const manager=getCredentialManager();const key=await manager.get({type:'source_apikey',workspaceId:ws,sourceId:'merqo-doudian-staging-key'});const creds=await manager.get({type:'source_apikey',workspaceId:ws,sourceId:ref});assert.equal(JSON.parse(creds.value).accessToken,'synthetic-ui-token');const db=new Database(file,{readonly:true});const pages=db.query('SELECT encrypted FROM sync_pages WHERE job_id=? ORDER BY page').all(job);let rows=[];for(const p of pages){const e=JSON.parse(p.encrypted),d=createDecipheriv('aes-256-gcm',Buffer.from(key.value,'base64'),Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));rows.push(...JSON.parse(Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()]).toString()));}assert.equal(rows.length,7);assert.equal(new Set(rows.map(r=>r.fixture_order_id)).size,7);db.close();for(const f of[file,file+'-wal'])if(existsSync(f)){const bytes=readFileSync(f);assert(!bytes.includes(Buffer.from('DEMO-1')));assert(!bytes.includes(Buffer.from('synthetic-ui-secret')));assert(!bytes.includes(Buffer.from('synthetic-ui-token')));}console.log('ENCRYPTED_STAGING_PASS');`;
 const proof=spawnSync('bun',['-e',verify,db,workspace.id,first.id,live.connection.credentialRef],{cwd:root,env:{...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config')},encoding:'utf8'});assert.equal(proof.status,0,proof.stderr);assert(proof.stdout.includes('ENCRYPTED_STAGING_PASS'));
 const credentialBytes=fs.readFileSync(path.join(profile,'config/credentials.enc'));assert(!credentialBytes.includes(Buffer.from('synthetic-ui-secret')));assert(!credentialBytes.includes(Buffer.from('synthetic-ui-token')));
 checks.push('credentials and staged pages are encrypted with workspace-scoped keys; renderer receives summaries only and cannot forge page commits or start an unchecked live connection');
 await close('final.zip');fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,checks,syntheticOnly:true,realPlatformCalls:0,profile},null,2));console.log(JSON.stringify({ok:true,out,checks}));
}
main().catch(async error=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,profile},null,2));if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});if(app){await page.context().tracing.stop({path:path.join(out,'failure.zip')}).catch(()=>{});await app.close().catch(()=>{});}console.error(error);process.exitCode=1;});
