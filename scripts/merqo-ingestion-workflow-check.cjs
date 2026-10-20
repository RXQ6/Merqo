// Real Electron IPC, encrypted staging, SQLite workers and UI. Synthetic fixtures only.
const {_electron:electron}=require(process.env.MERQO_PLAYWRIGHT_MODULE||'playwright');
const {expect}=require((process.env.MERQO_PLAYWRIGHT_MODULE||'playwright')+'/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(root,'.runtime/ingestion-ui-')),out=path.join(root,'artifacts/ingestion-workflow',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});let app,page;const checks=[];
const button=name=>page.getByRole('button',{name,exact:true});
async function request(input){const r=await page.evaluate(input=>window.electronAPI.retailRequest(input),input);assert(r.ok,r.error);return r;}
async function view(){return(await request({op:'sync_view'})).data;}
async function ingest(){return(await request({op:'ingest_view'})).data;}
async function ledger(source='demo'){return(await request({op:'transactions_page',source,startDate:'2026-10-01',endDate:'2026-10-31',basis:'event',shop:'',channel:'',offset:0,limit:100})).data;}
async function launch(){
 const env={...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config'),RETAILPILOT_USER_DATA_DIR:path.join(profile,'chromium'),RETAILPILOT_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/electron')],cwd:root,env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(30000);await page.context().tracing.start({screenshots:true,snapshots:true});
 await expect.poll(async()=>await page.getByRole('button',{name:/^(Get Started|开始使用|Setup later|稍后设置|仅使用经营分析)$/}).count()||await page.locator('[data-focus-zone="sidebar"]').count(),{timeout:30000}).toBeGreaterThan(0);
 for(const name of [/^仅使用经营分析$/,/^(Get Started|开始使用)$/,/^(Setup later|稍后设置)$/]){const b=page.getByRole('button',{name});if(await b.count())await b.click();}
 await expect.poll(async()=>await page.getByTestId('retail-workspace').isVisible()||await button('经营分析').isVisible(),{timeout:30000}).toBe(true);if(!await page.getByTestId('retail-workspace').isVisible())await button('经营分析').click();await button('平台接入').click();
}
async function close(name){await page.context().tracing.stop({path:path.join(out,name)});await app.close();app=null;}
async function configure(scenario){await button('1. 配置连接').click();await page.getByLabel('演练场景',{exact:true}).selectOption(scenario);await button('保存并下一步').click();await button('检测只读连接').click();await expect(page.getByRole('status').filter({hasText:'演练检查通过'})).toBeVisible();await button('下一步：同步范围').click();}
async function create(){const prior=(await view()).jobs.length;await page.getByLabel('每页条数',{exact:true}).fill('100');await button('开始演练拉取').click();await expect.poll(async()=>(await view()).jobs.length).toBeGreaterThan(prior);const j=(await view()).jobs[0];await expect.poll(async()=>(await view()).jobs.find(v=>v.id===j.id).status).toBe('fetched');return j;}
async function open(job){await page.getByRole('article',{name:`同步任务 ${job.id}`,exact:true}).getByRole('button',{name:'映射与入库',exact:true}).click();return page.getByRole('region',{name:`映射与入库 ${job.id}`,exact:true});}
async function preview(panel,job){await panel.getByRole('button',{name:'2. 生成入库预览',exact:true}).click();await expect(panel.getByRole('region',{name:'入库预览',exact:true})).toBeVisible();return(await ingest()).previews.find(p=>p.jobId===job.id);}
async function confirm(panel,job){await panel.getByRole('button',{name:'3. 确认入库',exact:true}).click();await expect(panel.getByRole('region',{name:'入库回执',exact:true})).toBeVisible();return(await ingest()).receipts.find(r=>r.jobId===job.id);}
async function main(){
 await launch();await configure('quality_errors');const first=await create();let panel=await open(first);
 await panel.getByRole('button',{name:'填入演练映射',exact:true}).click();await panel.getByRole('button',{name:'读取来源字段',exact:true}).click();await expect(panel).toContainText('抽样发现 15 个字段');
 await panel.getByRole('checkbox',{name:'我已核对来源事件含义、金额口径、时间与店铺归属',exact:true}).check();await panel.getByRole('button',{name:'保存映射版本',exact:true}).click();await expect(panel).toContainText('已保存映射，可预览');
 const bad=await preview(panel,first);assert.equal(bad.quarantinedRecords,2);assert.equal(bad.newEvents,16);assert.equal(bad.totals.eventCount,16);assert.equal((await ledger()).total,0);
 await expect(panel.getByRole('button',{name:'3. 确认入库',exact:true})).toBeDisabled();
 const denied=await page.evaluate(p=>window.electronAPI.retailRequest({op:'ingest_confirm',previewId:p.id,reviewHash:p.reviewHash,allowPartial:false,reason:''}),bad);assert.equal(denied.ok,false);
 await panel.getByLabel('允许部分入库',{exact:true}).check();await panel.getByLabel('部分入库原因',{exact:true}).fill('保留错误记录待修复，先验证有效事件入库');
 await panel.screenshot({path:path.join(out,'quality-preview.png')});const partial=await confirm(panel,first);assert.equal(partial.accepted,16);assert.equal(partial.quarantinedRecords,2);assert.equal((await ledger()).total,16);assert.equal((await ledger('csv')).total,0);
 await panel.getByRole('button',{name:'4. 与独立演练控制总额对账',exact:true}).click();await expect(panel.getByLabel('批次对账结果',{exact:true})).toContainText('存在差异');
 let reconciliation=(await ingest()).reconciliations.find(r=>r.receiptId===partial.id);assert.equal(reconciliation.status,'mismatch');assert(reconciliation.differences.some(d=>d.field==='eventCount'&&d.expected===22&&d.actual===16));
 checks.push('actual UI maps only explicit events; two bad source records quarantine together, preview writes nothing, partial import requires explicit reason and independent control totals expose 22 vs 16');
 await panel.screenshot({path:path.join(out,'partial-reconciliation.png')});
 await configure('normal');const corrected=await create();panel=await open(corrected);await expect(panel).toContainText('已保存映射，可预览');const good=await preview(panel,corrected);assert.equal(good.newEvents,6);assert.equal(good.duplicateEvents,16);assert.equal(good.quarantinedRecords,0);
 const completed=await confirm(panel,corrected);assert.equal(completed.accepted,6);assert.equal(completed.duplicates,16);assert.equal((await ledger()).total,22);
 await panel.getByRole('button',{name:'4. 与独立演练控制总额对账',exact:true}).click();await expect(panel.getByLabel('批次对账结果',{exact:true})).toContainText('合计一致');
 reconciliation=(await ingest()).reconciliations.find(r=>r.receiptId===completed.id);assert.equal(reconciliation.reference,'synthetic_control');assert.equal(reconciliation.status,'matched');assert.equal(reconciliation.ledgerIssues,0);
 checks.push('corrected fixture imports six missing events, deduplicates sixteen immutable events and matches independent 22-event synthetic control totals');
 await panel.screenshot({path:path.join(out,'corrected-reconciliation.png')});
 const third=await create();panel=await open(third);const repeated=await preview(panel,third);assert.equal(repeated.newEvents,0);assert.equal(repeated.duplicateEvents,22);const repeatReceipt=await confirm(panel,third);assert.equal(repeatReceipt.accepted,0);assert.equal(repeatReceipt.duplicates,22);
 await request({op:'ingest_confirm',previewId:repeated.id,reviewHash:repeated.reviewHash,allowPartial:false,reason:''});assert.equal((await ingest()).receipts.filter(r=>r.previewId===repeated.id).length,1);assert.equal((await ledger()).total,22);
 checks.push('repeated pulls import zero events; double confirmation returns one receipt and ledger remains 22 events');
 await close('before-restart.zip');await launch();const persisted=await ingest();assert.equal(persisted.receipts.length,3);assert.equal(persisted.reconciliations.length,2);assert.equal((await ledger()).total,22);panel=await open(corrected);await expect(panel.getByLabel('批次对账结果',{exact:true})).toContainText('合计一致');
 await panel.getByText('提供人工对账参考合计',{exact:true}).click();await panel.getByLabel('对账来源名称',{exact:true}).fill('独立手工参考（故意差异）');
 const manual={eventCount:22,orderedQty:7,paidQty:7,refundedQty:1,paidMinor:70001,refundedMinor:10000,discountMinor:0,subsidyMinor:0};for(const [key,value]of Object.entries(manual))await panel.getByLabel(`对账 ${key}`,{exact:true}).fill(String(value));
 await panel.getByRole('button',{name:'按人工参考合计对账',exact:true}).click();await expect(panel.getByLabel('批次对账结果',{exact:true})).toContainText('人工声明参考');await expect(panel.getByLabel('批次对账结果',{exact:true})).toContainText('存在差异');
 const manualResult=(await ingest()).reconciliations[0];assert.equal(manualResult.reference,'operator_declared');assert(manualResult.differences.some(d=>d.field==='paidMinor'&&d.expected===70001&&d.actual===70000));
 const forged=await page.evaluate(()=>window.electronAPI.retailRequest({op:'ingest_store_confirm',previewId:crypto.randomUUID(),reviewHash:'a'.repeat(64),stageDigest:'b'.repeat(64),allowPartial:true,reason:'forged internal request'}));assert.equal(forged.ok,false);
 checks.push('actual restart retains mappings, receipts and reconciliation; manual reference is distinctly unverified and a one-fen discrepancy is detected; renderer cannot call internal store operations');
 await panel.screenshot({path:path.join(out,'manual-reference.png')});await close('after-restart.zip');fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,checks,syntheticOnly:true,realPlatformCalls:0,profile},null,2));console.log(JSON.stringify({ok:true,out,checks}));
}
main().catch(async error=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,profile},null,2));if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});if(app){await page.context().tracing.stop({path:path.join(out,'failure.zip')}).catch(()=>{});await app.close().catch(()=>{});}console.error(error);process.exitCode=1;});
