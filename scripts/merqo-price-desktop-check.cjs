// Isolated native UI contract check. The local HTTP fixture is not a live-model quality evaluation.
const {_electron:electron}=require(process.env.MERQO_PLAYWRIGHT_MODULE||'playwright');
const {expect}=require((process.env.MERQO_PLAYWRIGHT_MODULE||'playwright')+'/test');
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const out=path.join(root,'artifacts/price-action',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});const profile=fs.mkdtempSync(path.join(root,'.runtime/price-ui-'));
let app,page,calls=0;const checks=[];
const server=http.createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);assert(!body.tools&&!body.functions);calls++;
 const system=body.messages[0].content;const context=JSON.parse(body.messages[1].content);
 const value=system.includes('串行只读 Reviewer')?{verdict:'passed',notes:['本地协议夹具，非真实模型质量评测']}:context.responseContract.remainingTools.length?{tool:context.responseContract.remainingTools[0]}:{report:{summary:'冻结价格与经营约束核验',observations:[],hypotheses:[],unknowns:['需求响应未知'],alternatives:['成本口径可能存在差异'],options:[{kind:'observe',rationale:'继续观察'},{kind:context.responseContract.reportExample.report.options[1].kind,rationale:'仅作条件测算'}]}};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}});
const button=name=>page.getByRole('button',{name,exact:true});
async function request(input){const r=await page.evaluate(input=>window.electronAPI.retailRequest(input),input);assert.equal(r.ok,true,r.error);return r;}
async function launch(){const env={...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config'),RETAILPILOT_USER_DATA_DIR:path.join(profile,'chromium'),RETAILPILOT_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/electron')],cwd:root,env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(25000);await page.context().tracing.start({screenshots:true,snapshots:true});
 const start=page.getByRole('button',{name:/^(Get Started|开始使用)$/});const later=page.getByRole('button',{name:/^(Setup later|稍后设置)$/});const retail=button('仅使用经营分析');
 await expect.poll(async()=>await start.count()||await later.count()||await retail.count()||await page.locator('[data-focus-zone="sidebar"]').count(),{timeout:30000}).toBeGreaterThan(0);
 if(await retail.count())await retail.click();if(await start.count())await start.click();if(await later.count())await later.click();
 await expect(page.locator('[data-focus-zone="sidebar"]')).toBeAttached();await expect.poll(async()=>await page.getByTestId('retail-workspace').isVisible()||await button('经营分析').count()>0,{timeout:30000}).toBe(true);if(!await page.getByTestId('retail-workspace').isVisible())await button('经营分析').click();await expect(page.getByTestId('retail-workspace')).toBeVisible();
}
async function main(){await new Promise(r=>server.listen(0,'127.0.0.1',r));await launch();
 const configPath=path.join(profile,'config/config.json');const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 config.llmConnections=[{slug:'price-contract',name:'本地改价协议夹具',providerType:'pi_compat',authType:'none',createdAt:Date.now(),baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'pi/deepseek-v4-flash',piAuthProvider:'deepseek',customEndpoint:{api:'openai-completions'}}];config.defaultLlmConnection='price-contract';fs.writeFileSync(configPath,JSON.stringify(config,null,2));
 await button('载入演示数据').click();await expect(button('开始调查 TEA-500')).toBeEnabled();
 const scopeEvidence=page.getByRole('region',{name:'当前统计范围与来源',exact:true});await expect(scopeEvidence).toContainText('2026-10-14');await expect(scopeEvidence).toContainText('导入时间不能替代');await scopeEvidence.getByText(/来源批次 · 当前范围 6 条快照/).click();await expect(scopeEvidence).toContainText('覆盖范围');checks.push('overview exposes business dates, full-scope batch counts and declared observation/coverage separately from import time');
 const before=(await request({op:'snapshot',source:'demo'})).data.records.find(r=>r.row.sku_id==='TEA-500');
 await button('开始调查 TEA-500').click();await expect(button('进行直接改价调查')).toBeEnabled({timeout:60000});await button('进行直接改价调查').click();
 await expect.poll(async()=>{const r=await request({op:'investigations'});return r.data.find(v=>v.marginAction==='set_price')?.state;},{timeout:60000}).toBe('completed');
 const run=(await request({op:'investigations'})).data.find(v=>v.marginAction==='set_price');assert(run.report.scenarios.some(s=>s.kind==='set_price'));
 await expect(page.getByRole('table',{name:'调查方案比较'})).toContainText('SKU标价 / 件');await expect(page.getByLabel('毛利数值事实',{exact:true})).toContainText('方案SKU标价');
 checks.push('native UI selects frozen direct-price investigation and displays independently audited price facts');
 await button('生成决策草稿').click();await page.getByLabel('决策方案',{exact:true}).selectOption('set_price');await page.getByLabel('决策备注',{exact:true}).fill('本地改价验收');await button('保存草稿').click();await expect(button('提交模拟审批')).toBeEnabled();await button('提交模拟审批').click();await button('查看审批').click();
 const approvalRisks=page.getByRole('region',{name:'审批来源水位与风险',exact:true});await expect(approvalRisks).toContainText('覆盖范围');await expect(approvalRisks).toContainText('必须独立创建并重新审批');await expect(approvalRisks).toContainText('不能覆盖后续人工修改');checks.push('approval exposes frozen source coverage, scenario risks and separately approved conditional compensation');
 await page.getByLabel('审批理由',{exact:true}).fill('核对冻结价格、毛利和未变的商家券');await button('批准模拟方案').click();await button('查看模拟执行').click();await page.getByLabel('确认仅写本地模拟账本',{exact:true}).check();await button('执行到模拟账本').click();
 await expect(page.getByRole('table',{name:'模拟执行实际值'})).toContainText('SKU标价 / 件');await expect(page.getByLabel('执行回读核对',{exact:true})).toContainText('回读核对一致');
 const executed=(await request({op:'executions'})).data.find(v=>v.receipt?.after.values.priceMinor!==undefined);assert(executed?.receipt);
 assert.equal(executed.receipt.after.values.couponMinor,before.row.coupon_minor);assert.equal(executed.receipt.after.values.priceMinor,run.report.scenarios.find(s=>s.kind==='set_price').values.priceMinor);
 assert.deepEqual((await request({op:'snapshot',source:'demo'})).data.records.find(r=>r.id===before.id).row,before.row);
 checks.push('UI draft, exact-version approval, price execution and readback preserve coupons and source snapshots');
 await button('申请补偿').click();await page.getByLabel('补偿申请理由',{exact:true}).fill('验收原价恢复约束');await button('生成补偿申请').click();await expect(page.getByTestId('retail-compensations')).toContainText('恢复原SKU价格会低于当前毛利下限');
 checks.push('UI refuses unsafe original-price restoration instead of bypassing the margin floor');
 await page.screenshot({path:path.join(out,'price-compensation.png'),fullPage:true});await page.context().tracing.stop({path:path.join(out,'trace.zip')});await app.close();app=null;
 await launch();const restored=(await request({op:'executions'})).data.find(v=>v.job.id===executed.job.id);assert.equal(restored.receipt.id,executed.receipt.id);assert.equal(restored.current.values.priceMinor,executed.current.values.priceMinor);checks.push('actual process restart preserves direct-price receipt and target version');
 await page.context().tracing.stop({path:path.join(out,'restart-trace.zip')});await app.close();app=null;server.close();
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,profile,checks,calls,modelFixture:true,liveModelQuality:false},null,2));console.log(JSON.stringify({ok:true,out,checks}));
}
main().catch(async e=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,profile,checks,error:e.stack},null,2));if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});if(app){await page.context().tracing.stop({path:path.join(out,'failed-trace.zip')}).catch(()=>{});await app.close().catch(()=>{});}server.close();console.error(e);process.exitCode=1;});
