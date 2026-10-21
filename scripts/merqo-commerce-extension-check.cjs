// Real isolated Electron UI and production worker. No model or platform requests.
const {_electron:electron}=require(process.env.MERQO_PLAYWRIGHT_MODULE||'playwright');
const {expect}=require((process.env.MERQO_PLAYWRIGHT_MODULE||'playwright')+'/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/commerce-ui',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});const profile=fs.mkdtempSync(path.join(root,'.runtime/commerce-ui-'));const checks=[];let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
async function launch(){
 const env={...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config'),RETAILPILOT_USER_DATA_DIR:path.join(profile,'chromium'),RETAILPILOT_SMOKE:'1'};
 for(const key of ['ELECTRON_RUN_AS_NODE','CRAFT_APP_ROOT','CRAFT_DEV_RUNTIME','NODE_PATH','NODE_OPTIONS'])delete env[key];
 const packaged=process.argv[2];if(packaged){env.PATH=process.env.SystemRoot+'\\System32;'+process.env.SystemRoot;env.CRAFT_BUN='';}
 app=await electron.launch({executablePath:packaged?path.resolve(packaged):path.join(root,'node_modules/electron/dist/electron.exe'),args:packaged?[]:[path.join(root,'apps/electron')],cwd:packaged?profile:root,env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(25000);
 await page.context().tracing.start({screenshots:true,snapshots:true});
 const start=page.getByRole('button',{name:/^(Get Started|开始使用)$/}),later=page.getByRole('button',{name:/^(Setup later|稍后设置)$/}),retail=button('仅使用经营分析');
 await expect.poll(async()=>await start.count()||await later.count()||await retail.count()||await page.locator('[data-focus-zone="sidebar"]').count(),{timeout:30000}).toBeGreaterThan(0);
 if(await retail.count())await retail.click();if(await start.count())await start.click();if(await later.count())await later.click();
 await expect.poll(async()=>await page.getByTestId('retail-workspace').isVisible()||await button('经营分析').count()>0,{timeout:30000}).toBe(true);if(!await page.getByTestId('retail-workspace').isVisible())await button('经营分析').click();
 await expect(page.getByTestId('retail-workspace')).toBeVisible();
 if(packaged){const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,bun:process.env.CRAFT_BUN}));assert.equal(runtime.packaged,true);assert(runtime.bun.startsWith(path.dirname(path.resolve(packaged))));}
}
async function request(input){const r=await page.evaluate(input=>window.electronAPI.retailRequest(input),input);assert.equal(r.ok,true,r.error);return r;}
async function download(name,file){
 const target=path.join(out,file);
 await app.evaluate(({BrowserWindow},target)=>{global.__commerceDownload='waiting';BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event,item)=>{item.setSavePath(target);item.once('done',(_event,state)=>{global.__commerceDownload=state;});});},target);
 await button(name).click();await expect.poll(()=>app.evaluate(()=>global.__commerceDownload),{timeout:30000}).toBe('completed');
 return fs.readFileSync(target,'utf8').replace(/^\uFEFF/,'');
}
async function upload(text){await page.getByLabel('选择交易事件 CSV',{exact:true}).setInputFiles({name:'commerce.csv',mimeType:'text/csv',buffer:Buffer.from(text)});}
async function importValid(text){await upload(text);const preview=page.getByRole('region',{name:'交易导入预览',exact:true});await expect(preview).toContainText('事件链校验通过');await button('确认导入交易事件').click();await expect(preview).not.toBeVisible();}
async function setQuery(start,end,basis){await page.getByLabel('交易开始日期',{exact:true}).fill(start);await page.getByLabel('交易结束日期',{exact:true}).fill(end);await page.getByLabel('交易时间归属',{exact:true}).selectOption(basis);await button('查询交易').click();await expect(page.getByRole('region',{name:'交易汇总',exact:true})).toBeVisible();}
async function main(){
 await launch();await button('交易与退款').click();await expect(page.getByRole('region',{name:'交易汇总',exact:true})).toBeVisible();
 const sample=await download('下载换货关联示例','exchange-template.csv'),rows=sample.split('\n'),head=rows[0];assert.equal(rows.length,9);
 await importValid(rows.slice(0,3).join('\n'));await setQuery('2026-10-14','2026-10-14','event');
 const totals=page.getByRole('region',{name:'交易汇总',exact:true});await expect(totals).toContainText('支付 0 件');await expect(totals).toContainText('支付结算 ¥40.00');
 checks.push('downloaded real exchange template imports deposit with cash but zero settled units');
 await importValid([head,...rows.slice(3)].join('\n'));await setQuery('2026-10-14','2026-10-16','event');
 await expect(totals).toContainText('支付 2 件');await expect(totals).toContainText('取消 1 件');await expect(totals).toContainText('实物退回 1 件');await expect(totals).toContainText('换货关联 1 件');await expect(totals).toContainText('保留结算 ¥85.00');
 await expect(page.getByRole('table',{name:/交易事件明细/})).toContainText('换货原行：O1/L1');
 checks.push('balance, cancellation, physical return, refund and linked replacement import through UI without duplicate cash or units');
 const invalid=rows.at(-1).replaceAll('EXCHANGE-O1','EXCHANGE-O2').replaceAll('EXCHANGE-E1','EXCHANGE-E2');await upload(head+'\n'+invalid);
 await expect(page.getByRole('region',{name:'交易导入预览',exact:true})).toContainText('未关联件数');await expect(button('确认导入交易事件')).toBeDisabled();await button('取消交易导入').click();
 assert.equal((await request({op:'transactions_page',source:'csv',startDate:'2026-10-14',endDate:'2026-10-16',basis:'event'})).data.total,8);
 checks.push('a second replacement cannot consume already linked returned units and leaves the ledger unchanged');
 const allocation=await download('下载订单分摊模板','allocation-template.csv');await page.getByLabel('选择订单分摊 CSV',{exact:true}).setInputFiles({name:'allocation.csv',mimeType:'text/csv',buffer:Buffer.from(allocation)});
 const allocationPanel=page.getByRole('region',{name:'订单优惠分摊',exact:true});await expect(allocationPanel).toContainText('已分摊 3 行');await expect(allocationPanel).toContainText('商家优惠合计 1 分，平台补贴合计 2 分');
 const result=await download('导出订单分摊结果','allocation-result.csv');assert(result.includes('"O1","A","100","true","1","2","1","1","100"'));assert(result.includes('"O1","GIFT","0","false","1","2","0","0","0"'));
 await page.screenshot({path:path.join(out,'transactions-and-allocation.png'),fullPage:true});checks.push('actual allocation template, preview and exported CSV conserve independent pools with deterministic residual and excluded gift');
 await button('数据与导入').click();const nested=await download('下载嵌套组合装示例','nested-template.csv');await page.getByLabel('选择经营 CSV 文件',{exact:true}).setInputFiles({name:'nested.csv',mimeType:'text/csv',buffer:Buffer.from(nested)});
 await expect(page.getByRole('region',{name:'导入预览',exact:true})).toContainText('有效 1 行');await button('导入 1 条有效数据').click();
 await expect(page.getByRole('region',{name:'导入预览',exact:true})).not.toBeVisible();await button('经营总览').click();
 await button('查看 NESTED-PACK 计算与证据').click();await expect(page.getByText('组合装子项（每销售包）',{exact:true})).toBeVisible();await expect(page.getByTestId('retail-workspace')).toContainText('TEA-PAIR');await expect(page.getByTestId('retail-workspace')).toContainText('TEA-UNIT');
 const record=(await request({op:'snapshot',source:'csv',limit:30})).data.records.find(r=>r.row.sku_id==='NESTED-PACK');assert.equal(record.calculation.profitMinor,2000);assert(record.ruleVersion.startsWith('retail-margin-v6'));
 await page.screenshot({path:path.join(out,'nested-tree.png'),fullPage:true});checks.push('downloaded nested pack imports through UI, renders child tree and independently calculates exact pack profit under version 6');
 await page.context().tracing.stop({path:path.join(out,'trace.zip')});await app.close();app=null;await launch();
 await button('交易与退款').click();await setQuery('2026-10-14','2026-10-16','order');await expect(page.getByRole('region',{name:'交易汇总',exact:true})).toContainText('换货关联 1 件');
 const saved=(await request({op:'snapshot',source:'csv',limit:30})).data.records.find(r=>r.id===record.id);assert.deepEqual(saved.row,record.row);
 checks.push('actual process restart retains replacement lineage, financial totals and nested composition');
 await button('库存与补货').click();await page.getByLabel('数据来源',{exact:true}).selectOption('demo');await button('载入库存与广告演示').click();
 for(const kind of ['inventory','ads']){await button(kind==='inventory'?'库存与补货':'广告经营').click();const section=page.getByTestId('signals-'+kind),sources=section.getByRole('region',{name:'当前统计范围与来源',exact:true});await expect(sources).toContainText('2026-10-14');await expect(sources.getByText(/来源批次 · 当前范围/)).toHaveCount(1);await sources.getByText(/来源批次 · 当前范围/).click();await expect(sources).toContainText('覆盖范围');await expect(sources).toContainText('导入时间不能替代');}
 checks.push('inventory and advertising expose full-scope business dates, grouped batches and independent source coverage in their actual pages');
 await page.context().tracing.stop({path:path.join(out,'restart-trace.zip')});await app.close();app=null;
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,profile,checks,modelCalls:0,realPlatform:false},null,2));console.log(JSON.stringify({ok:true,out,checks}));
}
main().catch(async e=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,profile,checks,error:e.stack},null,2));if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});if(app){await page.context().tracing.stop({path:path.join(out,'failed-trace.zip')}).catch(()=>{});await app.close().catch(()=>{});}console.error(e);process.exitCode=1;});
