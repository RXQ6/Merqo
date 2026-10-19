// Native Electron integration test: actual renderer actions, preload, IPC, Bun and SQLite.
const { app, nativeTheme, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = process.env.RETAILPILOT_M1_PROFILE;
if (!profile) throw new Error('Missing isolated profile');
process.env.CRAFT_CONFIG_DIR = path.join(profile, 'config');
process.env.RETAILPILOT_USER_DATA_DIR = path.join(profile, 'chromium');
process.env.RETAILPILOT_SMOKE = '1';
process.env.CRAFT_DEEPLINK_SCHEME = 'retailpilot';
const out = path.join(root, 'artifacts/m1'); fs.mkdirSync(out, { recursive: true });
const phase = process.env.RETAILPILOT_M1_PHASE || 'initial';
const checks = []; const failures = [];
let contractServer; let contractCalls = 0; let reviewVerdict='passed';
let finished = false;
function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  const result = { ok: !error, phase, checks, profile, error: error?.stack || null, failures };
  fs.writeFileSync(path.join(out, `e2e-${phase}.json`), JSON.stringify(result, null, 2));
  console.log('M1_E2E ' + JSON.stringify(result)); if(!error&&phase==='window-save')app.quit();else app.exit(error ? 1 : 0);
}
const timeout = setTimeout(() => finish(new Error('Retail UI test exceeded 300 seconds')), 300000);
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('preload-error', (_event, _preload, error) => failures.push(error.message));
  contents.on('did-finish-load', async () => {
    if (!contents.getURL().includes('renderer/index.html') || new URL(contents.getURL()).searchParams.get('surface')==='retail') return;
    const agentContents=contents; const agentJs=code=>agentContents.executeJavaScript(code);
    const js = async code => {try{return await contents.executeJavaScript(code);}catch(error){const body=await contents.executeJavaScript('document.body.innerText').catch(()=>'(unavailable)');throw new Error(error.message+'\nExpression: '+code.slice(0,1200)+'\nPage: '+body);}};
    const downloads = [];
    contents.session.on('will-download', (_event, item) => { const target = path.join(out, item.getFilename()); item.setSavePath(target); item.once('done', (_event, state) => downloads.push({ target, state })); });
    const capture = async name => {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(out, name), (await contents.capturePage()).toPNG());
    };
    async function waitFor(expression, label, timeoutMs = 12000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out: ' + label + '\n' + await js('document.body.innerText'));
    }
    const assert = async (expression, label) => { if (!await js(`(async () => (${expression}))()`)) throw new Error(label); checks.push(label); console.log('RETAIL_CHECK '+label); };
    const click = async text => {await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,text+' enabled');return js(`(() => { const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); button.click(); })()`);};
    const pointerClick = async text => {
      const target = await js(`(() => {
        const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&b.checkVisibility());
        if(!button||button.disabled)return {error:'Visible button unavailable'};
        const rect=button.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
        const hit=document.elementFromPoint(x,y);
        if(!hit||hit.closest('button')!==button)return {error:'Pointer blocked for '+${JSON.stringify(text)}+' by '+hit?.className};
        return {x,y,appRegion:getComputedStyle(button).getPropertyValue('-webkit-app-region')};
      })()`);
      if(target.error)throw new Error(target.error);
      contents.sendInputEvent({type:'mouseMove',x:target.x,y:target.y});
      contents.sendInputEvent({type:'mouseDown',x:target.x,y:target.y,button:'left',clickCount:1});
      contents.sendInputEvent({type:'mouseUp',x:target.x,y:target.y,button:'left',clickCount:1});
      return target;
    };
    const chooseExecution=async label=>{await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes(${JSON.stringify(label)}))`,label+' execution row loaded');await js(`Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes(${JSON.stringify(label)})).click()`);};
    const fillText=async(label,value)=>{await waitFor(`!!document.querySelector('textarea[aria-label="${label}"]')`,label+' ready');await js(`(()=>{const input=document.querySelector('textarea[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
    const approveCompensationUi=async()=>{await fillText('补偿审批理由','核对原回执、当前状态和补偿约束');await click('批准补偿');await waitFor(`!!document.querySelector('input[aria-label="确认执行本地模拟补偿"]')`, 'new compensation approved');await js(`document.querySelector('input[aria-label="确认执行本地模拟补偿"]').click()`);await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行模拟补偿'&&!b.disabled)`, 'compensation confirmed');await click('执行模拟补偿');await waitFor(`!!document.querySelector('[aria-label="模拟补偿回执"]')&&document.querySelector('[aria-label="补偿回读记录"]')?.innerText.includes('补偿回读核对一致')`, 'compensation receipt and reread');};
    const testDatabase=()=>{const visit=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()){const found=visit(file);if(found)return found;}else if(e.name==='operations.sqlite')return file;}return null;};const file=visit(profile);if(!file||!path.resolve(file).startsWith(path.resolve(profile)+path.sep))throw new Error('Isolated database scope missing');return file;};
    const testBun=(code,expectedExit=0)=>{const result=require('node:child_process').spawnSync(process.env.CRAFT_BUN||'bun',['--eval',code],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});if(result.status!==expectedExit)throw new Error(result.stderr||'fixture process exit '+result.status);return result.stdout.trim();};
    const testSql=sql=>testBun(`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(testDatabase()+'.investigations.sqlite')});db.exec(${JSON.stringify(sql)});db.close();`);
    const file = name => {
      const content = fs.readFileSync(path.join(root, 'fixtures/retail', name), 'utf8');
      return js(`(() => { const input = document.querySelector('input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, {type:'text/csv'})); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    };
    const signalFile = name => {
      const content = fs.readFileSync(path.join(root,'fixtures/retail',name),'utf8');
      return js(`(() => { const input=document.querySelector('input[aria-label="选择库存或广告 CSV"]');const t=new DataTransfer();t.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:'text/csv'}));input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    try {
      await waitFor(`!!document.querySelector('[data-focus-zone="sidebar"]') || /Get Started|开始使用|Setup later|稍后设置/.test(document.body.innerText)`, 'native desktop or welcome');
      if (!await js(`!!document.querySelector('[data-focus-zone="sidebar"]')`)) {
        await js(`Array.from(document.querySelectorAll('button')).find(el => /^(Get Started|开始使用)$/.test(el.textContent.trim()))?.click()`);
        await waitFor(`/Setup later|稍后设置/.test(document.body.innerText)`, 'defer model setup');
        await js(`Array.from(document.querySelectorAll('button')).find(el => /^(Setup later|稍后设置)$/.test(el.textContent.trim())).click()`);
      }
      await waitFor(`!!document.querySelector('[data-focus-zone="sidebar"]')`, 'original desktop shell');
      const desktopWindow = BrowserWindow.fromWebContents(contents);
      const initialWindowIds=BrowserWindow.getAllWindows().map(w=>w.id);
      const analysisVisible=`!!document.querySelector('[data-testid="retail-workspace"]')?.checkVisibility()`;
      if(phase==='window-restore') {
        await waitFor(analysisVisible, 'normal quit restores analysis in the original window');
        if(initialWindowIds.length!==1)throw new Error('Restoration created an extra analysis window');
        checks.push('normal quit restores one window with the analysis view');
      } else await click('经营分析');
      await waitFor(analysisVisible, 'same window analysis ready');
      await assert(`!document.querySelector('[data-focus-zone="sidebar"]').checkVisibility()&&document.querySelectorAll('.retail-nav-group').length===3`, 'analysis hides general sidebar and keeps three grouped sections');
      await js(`window.electronAPI.retailWindow('open')`);await js(`window.electronAPI.retailWindow('open')`);
      if(JSON.stringify(BrowserWindow.getAllWindows().map(w=>w.id))!==JSON.stringify(initialWindowIds))throw new Error('Repeated entry created another window');
      checks.push('repeated entry keeps the original native window');
      await assert(`(async()=>{const forged=await window.electronAPI.retailWindow({action:'open',workspaceId:'other'});return !forged.ok;})()`, 'navigation rejects renderer supplied workspace');
      await click('返回会话');
      await waitFor(`document.querySelector('[data-focus-zone="sidebar"]').checkVisibility()&&!document.querySelector('[data-testid="retail-workspace"]').checkVisibility()`, 'return to original conversation surface');
      await click('经营分析');await waitFor(analysisVisible,'reentry');
      await assert(`!!document.querySelector('.retail-windowbar')&&!!document.querySelector('.retail-navigation')`, 'analysis retains clean header and grouped navigation');
      if(phase==='offers'||phase==='offers-restart'){
        if(phase==='offers'){
          await click('数据与导入');await click('下载可售报价示例');
          const started=Date.now();
          while(!downloads.some(d=>d.state==='completed'&&d.target.endsWith('Merqo-可售报价示例.csv'))){if(Date.now()-started>12000)throw new Error('Offer CSV download timed out');await new Promise(resolve=>setTimeout(resolve,100));}
          const csv=fs.readFileSync(downloads.find(d=>d.target.endsWith('Merqo-可售报价示例.csv')).target,'utf8');
          await js(`(()=>{const input=document.querySelector('input[aria-label="选择经营 CSV 文件"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(csv)}],'offers.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await waitFor(`document.querySelector('[aria-label="导入预览"]')?.innerText.includes('有效 3 行')`, 'offer file preview accepts three rows');
          await assert(`document.querySelector('select[aria-label="映射 参考报价（可选：JSON）"]').value==='offers'`, 'offer scope and availability fields auto-map');
          await capture('offer-preview.png');await click('导入 3 条有效数据');
          await waitFor(`document.body.innerText.includes('已导入 3 条')`, 'offer import persisted through IPC worker');
        }
        await click('经营总览');await js(`(()=>{const select=document.querySelector('select[aria-label="数据来源"]');select.value='csv';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`document.querySelectorAll('tbody tr').length===3`, 'three offer snapshots visible');
        await assert(`document.querySelectorAll('tbody .retail-badge.needs_evidence').length===1&&document.querySelectorAll('tbody .retail-badge.normal').length===2`, 'offer valid/filtered/unknown states survive '+phase);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'snapshot'});const rows=r.data.records.filter(r=>r.source==='csv');return rows.length===3&&rows.find(r=>r.row.sku_id==='OFFER-FILTERED').calculation.revenueMinor===8000&&rows.find(r=>r.row.sku_id==='OFFER-UNKNOWN').calculation.profitMinor===null;})()`, 'reference price never overwrites revenue and unknown state persists '+phase);
        await js(`document.querySelector('button[aria-label="查看 OFFER-FILTERED 计算与证据"]').click()`);
        await waitFor(`document.querySelector('[aria-label="毛利计算与证据"]')?.innerText.includes('可售参考报价')`, 'offer evidence detail visible');
        await assert(`document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('筛选参考价：¥30.00')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('排除：报价明确无货')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('¥80.00')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('不替换成交收入')`, 'unavailable cheap offer excluded and reference limitation shown '+phase);
        await capture('offer-'+phase+'.png');finish();return;
      }
      if(phase==='members'||phase==='members-restart'){
        if(phase==='members'){
          await click('数据与导入');await click('下载会员价示例');
          const started=Date.now();
          while(!downloads.some(d=>d.state==='completed'&&d.target.endsWith('Merqo-会员价示例.csv'))){if(Date.now()-started>12000)throw new Error('Member CSV download timed out');await new Promise(resolve=>setTimeout(resolve,100));}
          const csv=fs.readFileSync(downloads.find(d=>d.target.endsWith('Merqo-会员价示例.csv')).target,'utf8');
          await js(`(()=>{const input=document.querySelector('input[aria-label="选择经营 CSV 文件"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(csv)}],'membership.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await waitFor(`document.querySelector('[aria-label="导入预览"]')?.innerText.includes('有效 3 行')`, 'member file preview accepts three rows');
          await assert(`document.querySelector('select[aria-label="映射 会员价格上下文（可选：JSON）"]').value==='membership'`, 'member price context auto-maps');
          await capture('member-preview.png');await click('导入 3 条有效数据');
          await waitFor(`document.body.innerText.includes('已导入 3 条')`, 'member import persisted through IPC worker');
        }
        await click('经营总览');await js(`(()=>{const select=document.querySelector('select[aria-label="数据来源"]');select.value='csv';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`document.querySelectorAll('tbody tr').length===3`, 'three member snapshots visible');
        await assert(`document.querySelectorAll('tbody .retail-badge.needs_evidence').length===1&&document.querySelectorAll('tbody .retail-badge.low_margin').length===1&&document.querySelectorAll('tbody .retail-badge.normal').length===1`, 'member normal/warning/unknown states survive '+phase);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'snapshot'});const rows=r.data.records.filter(r=>r.source==='csv');return rows.length===3&&rows.find(r=>r.row.sku_id==='MEMBER-WARNING').calculation.revenueMinor===6000&&rows.find(r=>r.row.sku_id==='MEMBER-MISSING').calculation.profitMinor===null;})()`, 'member price and unknown-identity block persist '+phase);
        await js(`document.querySelector('button[aria-label="查看 MEMBER-WARNING 计算与证据"]').click()`);
        await waitFor(`document.querySelector('[aria-label="毛利计算与证据"]')?.innerText.includes('会员价格上下文')`, 'member evidence detail visible');
        await assert(`document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('gold')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('¥65.00')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('0.00%')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('允许叠加')`, 'member effective price, cohort and discount policy shown '+phase);
        await capture('member-'+phase+'.png');finish();return;
      }
      if(phase==='gifts'||phase==='gifts-restart'){
        if(phase==='gifts'){
          await click('数据与导入');await click('下载赠品示例');
          const started=Date.now();
          while(!downloads.some(d=>d.state==='completed'&&d.target.endsWith('Merqo-赠品示例.csv'))){if(Date.now()-started>12000)throw new Error('Gift CSV download timed out');await new Promise(resolve=>setTimeout(resolve,100));}
          const csv=fs.readFileSync(downloads.find(d=>d.target.endsWith('Merqo-赠品示例.csv')).target,'utf8');
          await js(`(()=>{const input=document.querySelector('input[aria-label="选择经营 CSV 文件"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(csv)}],'gifts.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await waitFor(`document.querySelector('[aria-label="导入预览"]')?.innerText.includes('有效 3 行')`, 'gift file preview accepts three rows');
          await assert(`document.querySelector('select[aria-label="映射 赠品明细（可选：JSON）"]').value==='gifts'&&document.querySelector('select[aria-label="映射 赠品成本口径（可选：additional / included / unknown）"]').value==='gift_cost_basis'`, 'gift association and cost-basis fields auto-map');
          await capture('gift-preview.png');await click('导入 3 条有效数据');
          await waitFor(`document.body.innerText.includes('已导入 3 条')`, 'gift import persisted through IPC worker');
        }
        await click('经营总览');await js(`(()=>{const select=document.querySelector('select[aria-label="数据来源"]');select.value='csv';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`document.querySelectorAll('tbody tr').length===3`, 'three gift snapshots visible');
        await assert(`document.querySelectorAll('tbody .retail-badge.needs_evidence').length===1&&document.querySelectorAll('tbody .retail-badge.low_margin').length===1&&document.querySelectorAll('tbody .retail-badge.normal').length===1`, 'gift normal/warning/unknown states survive '+phase);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'snapshot'});const rows=r.data.records.filter(r=>r.source==='csv');return rows.length===3&&rows.find(r=>r.row.sku_id==='GIFT-WARNING').calculation.totalProfitMinor===5000&&rows.find(r=>r.row.sku_id==='GIFT-MISSING').calculation.profitMinor===null;})()`, 'gift-inclusive totals and unknown cost persist '+phase);
        await js(`document.querySelector('button[aria-label="查看 GIFT-WARNING 计算与证据"]').click()`);
        await waitFor(`document.querySelector('[aria-label="毛利计算与证据"]')?.innerText.includes('赠品关联（每销售件）')`, 'gift evidence detail visible');
        await assert(`document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('GIFT-SAMPLE')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('¥15.00')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('6.25%')`, 'gift component cost and inclusive margin shown '+phase);
        await capture('gift-'+phase+'.png');finish();return;
      }
      if(phase==='bundles'||phase==='bundles-restart'){
        if(phase==='bundles'){
          await click('数据与导入');
          await click('下载组合装示例');
          const started=Date.now();
          while(!downloads.some(d=>d.state==='completed'&&d.target.endsWith('Merqo-组合装示例.csv'))){if(Date.now()-started>12000)throw new Error('Bundle CSV download timed out');await new Promise(resolve=>setTimeout(resolve,100));}
          const csv=fs.readFileSync(downloads.find(d=>d.target.endsWith('Merqo-组合装示例.csv')).target,'utf8');
          await js(`(()=>{const input=document.querySelector('input[aria-label="选择经营 CSV 文件"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(csv)}],'bundle.csv',{type:'text/csv'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await waitFor(`document.querySelector('[aria-label="导入预览"]')?.innerText.includes('有效 3 行')`, 'bundle file preview accepts three rows');
          await assert(`document.querySelectorAll('.retail-mappings select').length===24&&document.querySelector('select[aria-label="映射 组合装子项（可选：JSON）"]').value==='bundle_components'`, 'optional bundle fields auto-map in actual renderer');
          await capture('bundle-preview.png');
          await click('导入 3 条有效数据');
          await waitFor(`document.body.innerText.includes('已导入 3 条')`, 'bundle import persisted through IPC worker');
        }
        await click('经营总览');
        await js(`(()=>{const select=document.querySelector('select[aria-label="数据来源"]');select.value='csv';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`document.querySelectorAll('tbody tr').length===3`, 'three bundle snapshots visible');
        await assert(`document.querySelectorAll('tbody .retail-badge.needs_evidence').length===2&&document.querySelectorAll('tbody .retail-badge.normal').length===1`, 'bundle normal/conflict/missing states survive '+phase);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'snapshot'});const rows=r.data.records.filter(r=>r.source==='csv');return rows.length===3&&rows.find(r=>r.row.sku_id==='PACK-NORMAL').calculation.totalProfitMinor===20000&&rows.filter(r=>r.status==='needs_evidence').every(r=>r.calculation.profitMinor===null);})()`, 'bundle pack totals and evidence gaps persist '+phase);
        await js(`document.querySelector('button[aria-label="查看 PACK-NORMAL 计算与证据"]').click()`);
        await waitFor(`document.querySelector('[aria-label="毛利计算与证据"]')?.innerText.includes('组合装子项（每销售包）')`, 'bundle evidence detail visible');
        await assert(`document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('TEA-UNIT')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('COFFEE-UNIT')&&document.querySelector('[aria-label="毛利计算与证据"]').innerText.includes('25.00%')`, 'component identities and computed pack margin shown '+phase);
        await capture('bundle-'+phase+'.png');finish();return;
      }
      if(phase==='checks'||phase==='checks-restart'){
        await click('经营巡检');await waitFor(`!!document.querySelector('[aria-label="巡检运行列表"]')`, 'checks UI ready');
        if(phase==='checks-restart'){
          await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});return r.ok&&!r.data.config.enabled&&r.data.runs.some(v=>v.trigger==='scheduled'&&v.status==='succeeded')&&new Set(r.data.runs.map(v=>v.config.revision+v.slot)).size===r.data.runs.length;})()`, 'check config, scheduled result and slot uniqueness survive restart');
          await capture('checks-restart.png');finish();return;
        }
        const beforeBusiness=await js(`(async()=>({approvals:(await window.electronAPI.retailRequest({op:'approvals'})).data.length,executions:(await window.electronAPI.retailRequest({op:'executions'})).data.length}))()`);
        await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});const c=r.data.config;const reset=await window.electronAPI.retailRequest({op:'check_configure',expectedRevision:c.revision,config:{enabled:false,source:'demo',intervalMinutes:15}});if(!reset.ok)throw new Error(reset.error);})()`);
        await click('刷新巡检记录');
        await js(`(()=>{const select=document.querySelector('select[aria-label="巡检启用状态"]');select.value='on';select.dispatchEvent(new Event('change',{bubbles:true}));const interval=document.querySelector('select[aria-label="巡检间隔"]');interval.value='15';interval.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await click('保存巡检配置');await waitFor(`document.querySelector('[data-testid="retail-checks"]').innerText.includes('配置已保存')`, 'enabled schedule saved');
        const config=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});return r.data.config;})()`);
        await waitFor(`document.querySelector('[aria-label="巡检运行列表"]').innerText.includes('定时 / v${config.revision}')`, 'actual shared SchedulerService minute tick creates a run',90000);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});const job=r.data.runs.find(v=>v.config.revision===${config.revision}&&v.trigger==='scheduled');return job?.status==='succeeded'&&job.result.byScenario.margin>0&&job.result.byScenario.inventory>0&&job.result.byScenario.ads>0;})()`, 'real minute callback checks three scenarios without model calls');
        await click('检查当前时段');await waitFor(`document.querySelector('[data-testid="retail-checks"]').innerText.includes('本次新运行')`, 'manual current slot result');await click('检查当前时段');
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});const denied=await window.electronAPI.retailRequest({op:'check_tick'});return !denied.ok&&new Set(r.data.runs.map(v=>v.config.revision+v.slot)).size===r.data.runs.length;})()`, 'manual reentry deduplicates slots and renderer cannot trigger internal scheduling');
        await capture('checks.png');
        await assert(`(async()=>{return (await window.electronAPI.retailRequest({op:'approvals'})).data.length===${beforeBusiness.approvals}&&(await window.electronAPI.retailRequest({op:'executions'})).data.length===${beforeBusiness.executions};})()`, 'scheduled checks create no approvals or executions');
        await js(`(()=>{const select=document.querySelector('select[aria-label="巡检启用状态"]');select.value='off';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('保存巡检配置');
        await waitFor(`(async()=>{const r=await window.electronAPI.retailRequest({op:'checks'});return r.ok&&!r.data.config.enabled;})()`, 'pause persisted');
        finish();return;
      }
      if(phase==='evidence'){
        const runId=await js(`(async()=>{const snapshot=await window.electronAPI.retailRequest({op:'snapshot'});const record=snapshot.data.records.find(r=>r.source==='demo'&&r.row.sku_id==='TEA-500');const result=await window.electronAPI.retailRequest({op:'investigate',recordId:record.id,scenario:'margin',mode:'replay',retry:true});if(!result.ok)throw new Error(result.error);return result.data[0].id;})()`);
        await waitFor(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigations',id:${JSON.stringify(runId)}});return r.ok&&r.data[0].report?.evidenceAssessment?.version==='margin-evidence-v1';})()`, 'new assessment persisted through actual worker and MCP',20000);
        await click('调查记录');await waitFor(`!!document.querySelector('[aria-label="毛利证据清单"]')`, 'evidence checklist visible');
        await assert(`document.querySelectorAll('[aria-label="毛利补证要求"] tbody tr').length===6&&document.querySelector('[aria-label="毛利证据清单"]').innerText.includes('尚不接收这类证据')`, 'six purpose-scoped requirements disclose unsupported import evidence');
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigation_export',id:${JSON.stringify(runId)},format:'json'});const bundle=JSON.parse(r.content);return bundle.investigation.report.evidenceAssessment.requirements.length===6&&bundle.investigation.report.reviewer.mode==='replay'&&bundle.investigation.report.reviewer.verdict==='needs_evidence';})()`, 'export retains checklist without upgrading offline approval authority');
        await js(`document.querySelector('[aria-label="毛利证据清单"]').scrollIntoView()`);await capture('margin-evidence-checklist.png');
        await click('前往数据与导入');await waitFor(`document.querySelector('.retail-main h1')?.textContent==='经营数据'`, 'evidence recovery navigates to existing import surface');
        checks.push('checklist recovery opens data import without mutating frozen reports');finish();return;
      }
      if(phase==='navigation'){
        for(const width of [1400,1000]){
          desktopWindow.setSize(width,900);
          await waitFor(`window.innerWidth===${width}`, 'resized native viewport');
          const target=await pointerClick('返回会话');
          if(target.appRegion!=='no-drag')throw new Error('Return button is inside draggable region');
          await waitFor(`document.querySelector('[data-focus-zone="sidebar"]').checkVisibility()&&!document.querySelector('[data-testid="retail-workspace"]').checkVisibility()`, 'pointer returns to conversation');
          await pointerClick('经营分析');await waitFor(analysisVisible,'pointer reopens analysis');
          await assert(`getComputedStyle(document.querySelector('.retail-windowbar')).getPropertyValue('-webkit-app-region')==='drag'`, 'analysis titlebar remains draggable at '+width);
          if(BrowserWindow.getAllWindows().length!==1)throw new Error('Pointer navigation created another window');
          checks.push('unobstructed native pointer round trip at '+width);
        }
        await capture('navigation-pointer.png');finish();return;
      }
      if(phase==='window-save'||phase==='window-restore'){
        await waitFor(`document.querySelectorAll('tbody tr').length===7`, 'same persisted workspace data');
        if(BrowserWindow.getAllWindows().length!==1)throw new Error('Lifecycle produced two windows');
        await capture('retail-window-'+phase+'.png');finish();return;
      }
      if (phase === 'restart') {
        await waitFor(`document.querySelectorAll('tbody tr').length === 7`, 'persisted snapshot finished loading');
        await assert(`document.querySelectorAll('tbody tr').length === 7`, 'original demo and explicit follow-up observation survive application restart');
        await click('调查记录');
        await waitFor(`document.body.innerText.includes('方案比较（代码测算）')`, 'investigation report survives restart');
        await js(`Array.from(document.querySelectorAll('.retail-investigation-list button')).find(b=>b.innerText.includes('离线演示')).click()`);await waitFor(`document.body.innerText.includes('离线规则演示，未调用模型')`, 'offline report selected after restart');await assert(`document.body.innerText.includes('离线规则演示，未调用模型') && document.querySelectorAll('.retail-investigation-list button').length>=7`, 'all three scenario histories survive restart');
        await js(`Array.from(document.querySelectorAll('.retail-investigation-list button')).filter(el=>el.innerText.includes('促销毛利调查') && el.innerText.includes('离线演示')).at(-1).click()`);
        await assert(`document.body.innerText.includes('20.00%')`, 'legacy margin report retains calculations');
        await click('返回经营总览');

        await js(`(() => { const select = document.querySelector('select[aria-label="数据来源"]'); select.value='csv'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 1`, 'persisted CSV row');
        await assert(`document.body.innerText.includes('33.33%') && document.body.innerText.includes('¥90.00')`, 'corrected margin survives application restart');
        await click('库存与广告');
        await waitFor(`document.querySelectorAll('[data-testid="signals-inventory"] tbody tr').length===1 && document.querySelectorAll('[data-testid="signals-ads"] tbody tr').length===1`, 'persisted scenario CSV rows');
        await assert(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('990') && document.querySelector('[data-testid="signals-ads"]').innerText.includes('4.00 / 3.00')`, 'inventory and advertising corrections survive restart');

        await click('决策草稿');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="决策草稿列表"] button')).find(b=>b.textContent.includes('v2')&&b.textContent.includes('减少商家券'))`, 'margin draft list');await js(`Array.from(document.querySelectorAll('[aria-label="决策草稿列表"] button')).find(b=>b.textContent.includes('v2')&&b.textContent.includes('减少商家券')).click()`);await waitFor(`document.body.innerText.includes('v2 已驳回')`, 'decision version and rejection persist across restart');await click('查看版本记录');await waitFor(`document.querySelector('[aria-label="决策版本记录"]')?.innerText.includes('已被新版本替代')`, 'decision request history persists across restart');checks.push('versioned draft and superseded approval request survive restart');
        await click('审批中心');await waitFor(`!!document.querySelector('select[aria-label="审批状态筛选"]')`, 'approval inbox after restart');
        await js(`(()=>{const select=document.querySelector('select[aria-label="审批状态筛选"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="审批申请列表"] button')).find(b=>b.textContent.includes('v2')&&b.textContent.includes('减少商家券'))`, 'rejected approval list');await js(`Array.from(document.querySelectorAll('[aria-label="审批申请列表"] button')).find(b=>b.textContent.includes('v2')&&b.textContent.includes('减少商家券')).click()`);await waitFor(`document.querySelector('[aria-label="审批结论"]')?.innerText.includes('还需核对成本口径')`, 'approval resolution and reason survive restart');
        await assert(`document.querySelector('[data-testid="retail-approvals"]').innerText.includes('已被新版本替代')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='批准模拟方案')`, 'superseded approval is visible and rejected decision cannot be approved again');

        await click('执行记录');await waitFor(`!!document.querySelector('[aria-label="模拟执行回执"]')`, 'simulation receipt persists after restart');await chooseExecution('调整模拟商家券');await waitFor(`document.querySelector('table[aria-label="模拟执行实际值"]')?.innerText.includes('¥15.00')`, 'margin receipt selected');await assert(`document.querySelector('table[aria-label="模拟执行实际值"]').innerText.includes('¥15.00')&&document.querySelector('[aria-label="执行回读核对"]').innerText.includes('回读核对一致')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='执行到模拟账本')`, 'successful simulation and reconciliation survive restart without another execution');
        await click('补偿记录');await waitFor(`!!document.querySelector('[aria-label="补偿申请列表"]')&&document.querySelector('[aria-label="补偿申请列表"]').innerText.includes('恢复模拟预算')`, 'compensation records after restart');await js(`Array.from(document.querySelectorAll('[aria-label="补偿申请列表"] button')).find(b=>b.innerText.includes('恢复模拟预算')).click()`);await waitFor(`!!document.querySelector('[aria-label="模拟补偿回执"]')`, 'compensation receipt persisted');await js(`document.querySelector('[aria-label="补偿版本记录"] > summary').click()`);await assert(`document.querySelector('table[aria-label="补偿实际结果"]').innerText.includes('¥1000.00')&&document.querySelector('[aria-label="补偿回读记录"]').innerText.includes('补偿回读核对一致')&&document.querySelector('[aria-label="补偿版本记录"]').innerText.includes('先补充恢复理由')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='执行模拟补偿')`, 'compensation receipt, reread, rejected history and no repeat action survive restart');
        await click('返回执行记录');await click('执行批次');await waitFor(`document.querySelector('[data-testid="retail-batches"]')?.innerText.includes('全部成功')`, 'batch status persists across restart');await js(`document.querySelector('[aria-label="批次恢复审计"] > summary').click()`);await assert(`document.querySelector('[aria-label="批次恢复审计"]').innerText.includes('本地原子账本无成功回执')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='继续待执行项'||b.textContent.trim()==='仅重试该失败项')`, 'batch recovery audit and no replay actions survive restart');
        await click('返回执行记录');await click('复盘与 Case');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="经营复盘列表"] button')).find(b=>b.innerText.includes('促销毛利'))`, 'review list after restart');await js(`Array.from(document.querySelectorAll('[aria-label="经营复盘列表"] button')).find(b=>b.innerText.includes('促销毛利')).click()`);await waitFor(`!!document.querySelector('[aria-label="已复核经营Case"]')`, 'Case survives restart');await assert(`document.querySelector('[aria-label="已复核经营Case"]').innerText.includes('同期活动未核实')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='复核并保存 Case')`, 'immutable Case, confounders and no overwrite action survive restart');await assert(`document.querySelector('table[aria-label="复盘指标比较"]').innerText.includes('¥70.00')&&document.querySelector('table[aria-label="复盘指标比较"]').innerText.includes('个百分点')&&!document.querySelector('table[aria-label="复盘指标比较"]').innerText.includes('分/件')&&!document.querySelector('table[aria-label="复盘指标比较"]').innerText.includes('（基点）')`, 'review display units match formatted currency and percentages');await capture('review-case.png');
      } else {
        await waitFor(`document.body.innerText.includes('从一组可核对的经营数据开始')`, 'empty state');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='载入演示数据'&&!el.disabled)`, 'demo action ready');
        await click('载入演示数据');
        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'demo imported before aging fixture');
        // Historical synthetic fixtures must remain usable without falsifying import timestamps.
        testBun(`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(testDatabase())});db.query("UPDATE retail_batches SET imported_at=? WHERE source='demo'").run('2000-01-01T00:00:00Z');db.close();const signals=new Database(${JSON.stringify(testDatabase()+'.signals.sqlite')});signals.query("UPDATE signal_batches SET imported_at=?,json=json_set(json,'$.importedAt',?) WHERE source='demo'").run('2000-01-01T00:00:00Z','2000-01-01T00:00:00Z');signals.close();`);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'demo'});if(!r.ok)throw new Error(r.error);const records=r.data.records.filter(e=>e.source==='demo');return records.length===6&&records.every(e=>e.importedAt==='2000-01-01T00:00:00Z')&&r.notice.includes('不受24小时限制');})()`, 'old demo reload preserves true import history and explains its age exemption');

        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'demo rows');
        await assert(`document.body.innerText.includes('¥7,125.00') && document.body.innerText.includes('¥1,765.00')`, 'demo totals match independently calculated revenue and gross profit');
        await capture('overview.png');
        nativeTheme.themeSource = 'dark';
        await waitFor(`document.documentElement.classList.contains('dark')`, 'desktop dark theme');
        await assert(`getComputedStyle(document.querySelector('.retail-app')).getPropertyValue('--paper').trim()==='#fff' && getComputedStyle(document.querySelector('.retail-app')).colorScheme==='light'`, 'retail analysis keeps its requested neutral light surface independent of Agent theme');
        await capture('overview-dark.png');
        nativeTheme.themeSource = 'light';
        await waitFor(`document.documentElement.classList.contains('light')`, 'desktop light theme');
        await click('返回会话');
        if(!await agentJs(`document.querySelector('[data-focus-zone="sidebar"]').checkVisibility()&&!document.querySelector('[data-testid="retail-workspace"]').checkVisibility()`))throw new Error('Primary shell was changed');
        await agentJs(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='经营分析').click()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'retail re-entry preserves current records');
        const primaryReply=await agentJs(`window.electronAPI.retailRequest({op:'snapshot'})`);const retailReply=await js(`window.electronAPI.retailRequest({op:'snapshot'})`);
        if(!primaryReply.ok||!retailReply.ok||JSON.stringify(primaryReply.data.records)!==JSON.stringify(retailReply.data.records))throw new Error('Retail opened a different workspace dataset');
        await js(`Array.from(document.querySelectorAll('[aria-label="经营导航"] button')).find(b=>b.textContent.startsWith('异常中心')).click()`);await waitFor(`document.querySelector('h1')?.textContent==='经营异常'`, 'analysis selected page');
        await click('返回会话');await click('经营分析');
        await waitFor(`document.querySelector('h1')?.textContent==='经营异常'`, 'analysis page preserved after round trip');
        await click('经营总览');
        if(BrowserWindow.getAllWindows().length!==initialWindowIds.length||BrowserWindow.fromWebContents(contents).id!==desktopWindow.id)throw new Error('Round trip changed the native window');
        checks.push('conversation round trip preserves analysis state and original workspace scope');
        await js(`document.querySelector('button[aria-label="查看 TEA-500 计算与证据"]').click()`);
        await waitFor(`!!document.querySelector('[role=dialog]')`, 'evidence drawer');
        await assert(`document.querySelector('[role=dialog]').innerText.includes('14.29%') && document.querySelector('[role=dialog]').innerText.includes('¥70.00') && document.querySelector('[role=dialog]').innerText.includes('快照 SHA-256')`, 'evidence drawer shows formula, margin and source hash');
        await capture('evidence.png');
        contents.sendInputEvent({type:'keyDown', keyCode:'Escape'});
        contents.sendInputEvent({type:'keyUp', keyCode:'Escape'});
        await waitFor(`!document.querySelector('[role=dialog]') && !!document.querySelector('[data-testid="retail-workspace"]')`, 'Escape closes evidence without leaving analysis');
        checks.push('evidence participates in native dismissible layer stack');
        await js(`document.querySelector('button[aria-label="开始调查 TEA-500"]').click()`);
        await waitFor(`document.body.innerText.includes('未配置模型连接')`, 'missing model fails honestly');
        checks.push('start investigation is visible and missing model is not simulated as success');
        // Exercise the actual main-process HTTP inference adapter against a local contract server.
        contractServer = require('node:http').createServer(async (req, res) => {
          try {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const request = JSON.parse(raw); contractCalls++;
            if (request.tools || request.functions) throw new Error('Native tools must never be exposed');
            if (request.thinking?.type !== 'disabled') throw new Error('DeepSeek structured decision requests must disable implicit thinking');
            const system = request.messages[0].content;
            const context = JSON.parse(request.messages[1].content);
            const toolNames = ['retail_get_data_health','retail_get_sku_context',context.scenario === 'inventory' ? 'retail_get_inventory' : context.scenario === 'ads' ? 'retail_get_campaigns' : 'retail_get_promotions','retail_simulate_actions'];
            let output;
            if (system.includes('串行只读 Reviewer')) output = {verdict:reviewVerdict, notes:['本地协议测试复核，非真实模型质量验证；复核意见标记 '+reviewVerdict]};
            else if (context.observations.length < 4) output = {tool:toolNames[context.observations.length]};
            else output = {report:{summary:'本地协议测试报告，非真实模型生成的业务结论',observations:[],hypotheses:[],unknowns:['缺少实时数据'],alternatives:['成本或优惠分摊口径可能错误'],options:[{kind:'observe',rationale:'补证后再决定'},{kind:context.scenario === 'inventory' ? 'replenish_draft' : context.scenario === 'ads' ? 'reduce_budget' : 'reduce_coupon',rationale:'仅作条件测算'}]}};
            res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
          } catch(e) { failures.push(e.message); res.statusCode=500; res.end('{}'); }
        });
        await new Promise(resolve => contractServer.listen(0,'127.0.0.1',resolve));
        const configPath = path.join(profile,'config/config.json');
        const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
        config.llmConnections = [{slug:'m2-contract',name:'本地协议测试（非真实模型）',providerType:'pi_compat',authType:'none',createdAt:Date.now(),baseUrl:`http://127.0.0.1:${contractServer.address().port}/v1`,defaultModel:'pi/deepseek-v4-flash',piAuthProvider:'deepseek',customEndpoint:{api:'openai-completions'}}];
        config.defaultLlmConnection='m2-contract'; fs.writeFileSync(configPath,JSON.stringify(config,null,2));
        await click('重新进行模型调查');
        await waitFor(`document.body.innerText.includes('本地协议测试报告') && document.body.innerText.includes('只读 Reviewer 复核')`, 'model transport and bounded tool loop');
        if (contractCalls !== 6) throw new Error('Expected 5 model decisions and one reviewer call, got '+contractCalls);
        await capture('investigation-contract.png');
        await waitFor(`!!document.querySelector('[aria-label="毛利数值核验"]')`, 'code numeric audit visible in investigation');
        await js(`document.querySelector('[aria-label="毛利数值核验"] > summary').click()`);
        await assert(`Array.from(document.querySelectorAll('table[aria-label="毛利数值事实"] tbody tr')).some(r=>r.innerText.includes('商家券减少额')&&r.innerText.includes('¥5.00'))&&document.querySelector('table[aria-label="毛利数值事实"]').innerText.includes('快照合计')`, 'margin numeric audit distinguishes unit, total and five-yuan coupon reduction');
        await capture('margin-numeric.png');await js(`document.querySelector('[aria-label="毛利数值核验"] > summary').click()`);

        checks.push('real inference adapter executes six local HTTP contract calls with no native tool authority');
        await assert(`(await window.electronAPI.retailRequest({op:'investigations'})).data.filter(r=>r.state==='completed').every(r=>r.trace.filter(t=>t.stage==='investigate').length===4&&r.trace.filter(t=>t.stage==='investigate').every(t=>t.transport==='mcp_stdio'))`, 'desktop investigation uses four actual MCP stdio tool calls');
        await click('导出报告与证据 JSON');
        await waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='导出 Markdown')?.disabled`, 'JSON export request ready');
        const exportDeadline = Date.now()+10000; while(downloads.length<1&&Date.now()<exportDeadline)await new Promise(r=>setTimeout(r,100));
        if(downloads.length!==1||downloads[0].state!=='completed')throw new Error('JSON export did not complete');
        const exported=JSON.parse(fs.readFileSync(downloads[0].target,'utf8'));
        if(exported.evidenceIndex.length!==4||!exported.evidenceIndex.every(e=>e.transport==='mcp_stdio')||!exported.investigation.evidence.snapshotHash)throw new Error('Exported evidence/provenance incomplete');
        if(exported.investigation.report?.numericAudit?.version!=='margin-facts-v1'||!exported.investigation.report.numericAudit.facts.some(f=>f.key==='couponReduction'&&f.value===500))throw new Error('Exported numeric audit or delta missing');
        await click('导出 Markdown'); const mdDeadline=Date.now()+10000;while(downloads.length<2&&Date.now()<mdDeadline)await new Promise(r=>setTimeout(r,100));
        if(downloads.length!==2||!fs.readFileSync(downloads[1].target,'utf8').includes(exported.runId))throw new Error('Markdown export lacks run ID');
        checks.push('JSON and Markdown download through native desktop and retain frozen evidence index');
        await click('生成决策草稿');
        await waitFor(`!!document.querySelector('[data-testid="retail-decisions"]') && !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存草稿'&&!b.disabled)`, 'decision editor');
        await click('保存草稿');
        await waitFor(`!!document.querySelector('table[aria-label="决策前后值"]') && document.body.innerText.includes('¥15.00')`, 'deterministic decision before and after');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='提交模拟审批'&&!b.disabled)`, 'simulation request ready');
        await click('提交模拟审批'); await waitFor(`document.querySelector('[data-testid="retail-decisions"]').innerText.includes('模拟待审批')`, 'pending simulation approval');
        await assert(`(async()=>{const d=(await window.electronAPI.retailRequest({op:'decisions'})).data[0];const again=await window.electronAPI.retailRequest({op:'decision_submit',id:d.id,expectedVersion:d.version});return again.ok&&again.data[0].request.id===d.request.id;})()`, 'duplicate simulated approval requests are idempotent');
        await click('查看审批');await waitFor(`!!document.querySelector('table[aria-label="审批前后值"]')`, 'approval details');
        await assert(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='批准模拟方案').disabled`, 'approval requires an explicit reason');
        await js(`(()=>{const input=document.querySelector('textarea[aria-label="审批理由"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'已核对演示数据与条件约束');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('批准模拟方案');await waitFor(`!!document.querySelector('[aria-label="审批结论"]')&&document.querySelector('[data-testid="retail-approvals"]').innerText.includes('模拟已批准')`, 'approved decision recorded');
        await assert(`(async()=>{const a=(await window.electronAPI.retailRequest({op:'approvals'})).data[0];const forged=await window.electronAPI.retailRequest({op:'approval_resolve',requestId:a.id,expectedVersion:a.decision.version,expectedActionHash:a.decision.actionHash,choice:'approve',reason:'伪造身份',actor:'admin'});const again=await window.electronAPI.retailRequest({op:'approval_resolve',requestId:a.id,expectedVersion:a.decision.version,expectedActionHash:a.decision.actionHash,choice:'approve',reason:'已核对演示数据与条件约束'});return !forged.ok&&again.ok&&again.data[0].resolution.id===a.resolution.id&&a.resolution.actor.id==='local-simulation-approver';})()`, 'approval actor comes from server, forged identity rejects and retries remain idempotent');
        await capture('approval-approved.png');
        await click('查看模拟执行');await waitFor(`!!document.querySelector('table[aria-label="模拟执行预期值"]')`, 'simulation execution detail');
        await assert(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行到模拟账本').disabled`, 'explicit local simulation confirmation is required');
        await js(`document.querySelector('input[aria-label="确认仅写本地模拟账本"]').click()`);await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行到模拟账本'&&!b.disabled)`, 'confirmed simulation execution');await click('执行到模拟账本');
        await waitFor(`!!document.querySelector('[aria-label="模拟执行回执"]')&&document.querySelector('[aria-label="执行回读核对"]')?.innerText.includes('回读核对一致')`, 'atomic local simulation receipt and reconciliation');
        await capture('simulation-executed.png');
        await assert(`(async()=>{const e=(await window.electronAPI.retailRequest({op:'executions'})).data[0];const forged=await window.electronAPI.retailRequest({op:'simulation_execute',id:e.job.id,expectedVersion:1,expectedActionHash:e.job.actionHash,actor:'admin'});const repeated=await window.electronAPI.retailRequest({op:'simulation_execute',id:e.job.id,expectedVersion:1,expectedActionHash:e.job.actionHash});const next=repeated.data[0];const source=await window.electronAPI.retailRequest({op:'snapshot'});return !forged.ok&&repeated.ok&&next.receipt.id===e.receipt.id&&next.attempts.length===1&&next.current.version===1&&next.current.values.couponMinor===1500&&source.data.records.find(r=>r.source==='demo'&&r.row.sku_id==='TEA-500').row.coupon_minor===2000;})()`, 'execution is server-scoped, idempotent and isolated from source snapshots');
        await click('重新回读核对');await waitFor(`document.querySelector('[data-testid="retail-executions"] [role="status"]')?.innerText.includes('回读核对一致')`, 'manual reconciliation');
        await click('返回审批中心');await waitFor(`!!document.querySelector('[data-testid="retail-approvals"]')`, 'return approval');await click('返回决策草稿');await waitFor(`!!document.querySelector('textarea[aria-label="决策备注"]')`, 'return approved draft');

        await js(`(()=>{const input=document.querySelector('textarea[aria-label="决策备注"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'回归修订v2');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('保存新版本'); await waitFor(`document.querySelector('[data-testid="retail-decisions"]').innerText.includes('v2 草稿')`, 'new decision revision');
        await click('查看版本记录');await waitFor(`!!document.querySelector('[aria-label="决策版本记录"]') && document.querySelector('[aria-label="决策版本记录"]').innerText.includes('已被新版本替代')`, 'old request superseded');
        await capture('decision-draft.png');
        checks.push('decision draft, exact-version simulation submission, revision and superseded request work in desktop');
        await click('提交模拟审批');await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='查看审批')`, 'revision submitted');await click('查看审批');
        await waitFor(`!!document.querySelector('textarea[aria-label="审批理由"]')`, 'revised approval details');
        await js(`(()=>{const input=document.querySelector('textarea[aria-label="审批理由"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'还需核对成本口径');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('驳回方案');await waitFor(`document.querySelector('[aria-label="审批结论"]')?.innerText.includes('还需核对成本口径')`, 'rejection reason persists');
        await capture('approval-rejected.png');checks.push('approve, execute isolated simulation, supersede old approval, reject revision and preserve history without real business writes');
        await click('返回决策草稿');await waitFor(`document.querySelector('[data-testid="retail-decisions"]')?.innerText.includes('已驳回')`, 'rejected decision status');

        await click('调查记录');await waitFor(`!!document.querySelector('[data-testid="retail-investigation"]')&&document.body.innerText.includes('本地协议测试报告')`, 'return to investigated report');
        await click('导出报告与证据 JSON');const revisionExportDeadline=Date.now()+10000;while(downloads.length<3&&Date.now()<revisionExportDeadline)await new Promise(r=>setTimeout(r,100));
        const revisionExport=JSON.parse(fs.readFileSync(downloads[2].target,'utf8'));if(revisionExport.decisions.length!==2||revisionExport.decisions[1].request.status!=='superseded'||revisionExport.decisions[1].approvalResolution?.decision!=='approved'||revisionExport.decisions[0].approvalResolution?.decision!=='rejected'||revisionExport.executions?.[0]?.status!=='succeeded')throw new Error('Export lacks decision version history');checks.push('report export includes decision history, superseded request and execution receipt');



        await click('运行离线规则演示');
        await waitFor(`document.body.innerText.includes('离线规则演示，未调用模型') && document.body.innerText.includes('方案比较（代码测算）')`, 'explicit offline replay');
        await assert(`document.querySelectorAll('table[aria-label="调查方案比较"] tbody tr').length === 2 && document.body.innerText.includes('20.00%') && document.body.innerText.includes('14.29%')`, 'two deterministic scenarios and evidence are displayed');
        await capture('investigation-replay.png');
        await assert(`(await window.electronAPI.retailRequest({op:'investigation_update',id:'forged',report:{}})).ok === false`, 'renderer cannot forge investigation completion');
        checks.push('explicit offline replay remains distinct from model investigation');
        await click('返回经营总览');
        await click('库存与广告');
        for (const kind of ['inventory', 'ads']) {
          await waitFor(`!!document.querySelector('button[aria-label="开始调查 TEA-500 ${kind}"]:not(:disabled)')`, kind+' paged evidence ready');
          await js(`document.querySelector('button[aria-label="开始调查 TEA-500 ${kind}"]').click()`);
          await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('本地协议测试报告') && document.querySelector('.retail-investigation-body')?.innerText.includes('只读 Reviewer 复核')`, kind+' model report');
          await assert(`document.querySelectorAll('table[aria-label="调查方案比较"] tbody tr').length===2`, kind+' model conditional plans');
          await click('运行离线规则演示');
          await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('离线规则演示，未调用模型') && document.querySelector('.retail-investigation-body')?.innerText.includes('方案比较（代码测算）')`, kind+' replay');
          if(kind==='inventory') await assert(`document.querySelector('table[aria-label="调查方案比较"]').innerText.includes('100.00') && document.querySelector('table[aria-label="调查方案比较"]').innerText.includes('未通过')`, 'inventory plan does not erase pre-arrival gap');
          else await assert(`document.querySelector('table[aria-label="调查方案比较"]').innerText.includes('¥900.00') && document.querySelector('table[aria-label="调查方案比较"]').innerText.includes('¥1620.00') && document.querySelector('table[aria-label="调查方案比较"]').innerText.includes('1.80')`, 'ads budget scales revenue at unchanged ROAS');
          await capture(`investigation-${kind}.png`);
          await click('返回经营总览'); await click('库存与广告');
        }
        if (contractCalls!==18) throw new Error('Expected 18 HTTP calls for three scenarios, got '+contractCalls);
        await assert(`(await window.electronAPI.retailRequest({op:'investigations'})).data.filter(r=>r.report).every(r=>r.trace.filter(t=>t.stage==='investigate').every(t=>t.transport==='mcp_stdio'))`, 'all three scenarios and offline replay consume actual MCP evidence');
        checks.push('inventory and ads model contracts, readonly Reviewer and explicit offline plans passed');
        await click('调查记录');await waitFor(`!!document.querySelector('[data-testid="retail-investigation"]')`, 'investigations for blocker recovery');
        await click('运行离线规则演示');await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('离线规则演示，未调用模型')&&document.querySelector('.retail-investigation-body')?.innerText.includes('方案比较（代码测算）')`, 'offline source ready');
        await click('生成决策草稿');await waitFor(`!!document.querySelector('[data-testid="retail-decisions"]')`, 'offline draft editor');await click('保存草稿');
        await waitFor(`document.querySelector('[aria-label="草稿关联调查"]')?.innerText.includes('离线规则演示（没有模型审核）')`, 'offline source reason in draft');
        await assert(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='提交模拟审批')?.disabled`, 'offline draft cannot submit simulation approval');
        const offlineDraft=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'decisions'});if(!r.ok)throw new Error(r.error);return r.data[0];})()`);const callsBeforeOpen=contractCalls;
        await click('查看原调查与补证');await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('离线规则演示，未调用模型')`, 'open exact offline origin');
        await assert(`document.querySelector('.retail-investigation-list button[aria-current="true"]')?.innerText.includes('离线演示')`, 'draft recovery opens the original offline record');
        if(contractCalls!==callsBeforeOpen)throw new Error('Reading original investigation invoked a model');
        await assert(`(await window.electronAPI.retailRequest({op:'investigations',id:${JSON.stringify(offlineDraft.investigationId)}})).data[0].id===${JSON.stringify(offlineDraft.investigationId)}`, 'exact run read works through renderer IPC');
        for(const verdict of ['needs_evidence','rejected']){
          reviewVerdict=verdict;await click('重新进行模型调查');await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('复核意见标记 ${verdict}')&&document.querySelector('.retail-investigation-body')?.innerText.includes('方案比较（代码测算）')`, verdict+' report ready');
          await click('生成决策草稿');await waitFor(`!!document.querySelector('[data-testid="retail-decisions"]')`, 'blocked model draft editor');await click('保存草稿');
          await waitFor(`document.querySelector('[aria-label="草稿关联调查"]')?.innerText.includes('复核意见标记 ${verdict}')`, verdict+' notes retained in draft');
          await assert(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='提交模拟审批')?.disabled`, verdict+' cannot submit approval');
          await capture('reviewer-'+verdict+'.png');await click('查看原调查与补证');await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('复核意见标记 ${verdict}')`, 'exact blocked model origin');
        }
        reviewVerdict='passed';await click('重新进行模型调查');await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('复核意见标记 passed')`, 'restore independent passed fixture for later execution checks');checks.push('offline, needs-evidence and rejected drafts expose exact origin without automatic model calls or approval bypass');


        await click('经营总览');

        await js(`Array.from(document.querySelectorAll('nav button')).find(el=>el.textContent.includes('异常中心')).click()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 8`, 'three-scenario anomaly-only view');
        checks.push('unified anomaly center excludes all four normal rows across three scenarios');
        await file('import-with-errors.csv');
        await waitFor(`document.body.innerText.includes('总计 3 行，有效 1 行，隔离 2 行')`, 'CSV preview and quarantine');
        await capture('import-preview.png');
        await click('导入 1 条有效数据');
        await waitFor(`document.body.innerText.includes('已导入 1 条，隔离 2 条')`, 'CSV import committed');
        await file('import-with-errors.csv');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='导入 1 条有效数据'&&!el.disabled)`, 'repeat CSV ready');
        await click('导入 1 条有效数据');
        await waitFor(`document.body.innerText.includes('未重复写入')`, 'idempotent reimport'); checks.push('repeat file is idempotent');
        await file('corrected-margin.csv');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='导入 1 条有效数据'&&!el.disabled)`, 'correction preview');
        await click('导入 1 条有效数据');
        await waitFor(`document.body.innerText.includes('已导入 1 条，隔离 0 条')`, 'correction committed');
        await click('经营总览');
        await waitFor(`document.querySelectorAll('tbody tr').length===1 && document.body.innerText.includes('33.33%')`, 'corrected current snapshot');
        checks.push('correction changes current SKU to 33.33% while retaining source separation');
        await assert(`(await window.electronAPI.retailRequest({op:'snapshot',workspace_id:'other'})).ok === false`, 'IPC rejects renderer-supplied workspace scope');
        await assert(`(await window.electronAPI.retailRequest({op:'execute_price',price:1})).ok === false`, 'IPC rejects business execution operations');
        await click('库存与广告');
        await click('载入库存与广告演示');
        await waitFor(`document.querySelectorAll('[data-testid="signals-inventory"] tbody tr').length===3 && document.querySelectorAll('[data-testid="signals-ads"] tbody tr').length===3`, 'inventory and advertising demo rows');
        await assert(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('40 / 2.00 天') && document.querySelector('[data-testid="signals-ads"]').innerText.includes('-40.00%')`, 'inventory coverage and ROAS decline match independent arithmetic');
        await js(`document.querySelector('summary[aria-label="查看 TEA-500 inventory 场景证据"]').click()`);
        await assert(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('在途不计入即时可售') && document.querySelector('[data-testid="signals-inventory"]').innerText.includes('SHA-256')`, 'scenario evidence shows rule, formula and immutable source hash');
        await capture('inventory-advertising.png');
        await signalFile('inventory-errors.csv');
        await waitFor(`document.body.innerText.includes('总计 3 行，有效 1 行，隔离 2 行')`, 'inventory partial quarantine preview');
        await click('导入 1 条场景数据');
        await waitFor(`document.body.innerText.includes('已导入 1 条，隔离 2 条')`, 'inventory import');
        await signalFile('inventory-errors.csv');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='导入 1 条场景数据'&&!el.disabled)`, 'repeat inventory preview');
        await click('导入 1 条场景数据');
        await waitFor(`document.body.innerText.includes('未重复写入')`, 'inventory idempotence');
        await signalFile('inventory-corrected.csv');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='导入 1 条场景数据'&&!el.disabled)`, 'inventory correction preview');
        await click('导入 1 条场景数据');
        await waitFor(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('990')`, 'inventory correction');
        await js(`(() => { const select=document.querySelector('select[aria-label="场景导入类型"]');select.value='ads';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await signalFile('ads-errors.csv');
        await waitFor(`document.body.innerText.includes('总计 3 行，有效 1 行，隔离 2 行')`, 'advertising quarantine preview');
        await click('导入 1 条场景数据');
        await waitFor(`document.querySelector('[data-testid="signals-ads"]').innerText.includes('-40.00%')`, 'advertising import');
        await signalFile('ads-corrected.csv');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='导入 1 条场景数据'&&!el.disabled)`, 'advertising correction preview');
        await click('导入 1 条场景数据');
        await waitFor(`document.querySelector('[data-testid="signals-ads"]').innerText.includes('4.00 / 3.00')`, 'advertising correction');
        await js(`(() => { const select=document.querySelector('select[aria-label="数据来源"]');select.value='demo';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await js(`Array.from(document.querySelectorAll('nav button')).find(el=>el.textContent.includes('异常中心')).click()`);
        await waitFor(`document.querySelectorAll('tbody tr').length===8`, 'unified center contains four margin plus four stock/advertising anomalies');
        checks.push('two new scenarios support CSV quarantine, idempotence, correction, evidence and unified anomaly center');
        await assert(`(await Promise.all([window.electronAPI.retailRequest({op:'snapshot'}),window.electronAPI.retailRequest({op:'signals'})])).every(r=>r.ok)`, 'concurrent read refreshes do not block page remounts');
        for(const kind of ['ads','inventory']) {
          await click('库存与广告');
          if(kind==='inventory'){await click('载入补货执行演示');await waitFor(`document.body.innerText.includes('已载入1天交期')`, 'feasible built-in replenishment demo');}
          await waitFor(`!!document.querySelector('button[aria-label="开始调查 TEA-500 ${kind}"]')&&!document.querySelector('button[aria-label="开始调查 TEA-500 ${kind}"]').disabled`, kind+' investigation enabled after pending read');
          await js(`document.querySelector('button[aria-label="开始调查 TEA-500 ${kind}"]').click()`);
          await waitFor(`document.querySelector('.retail-investigation-body')?.innerText.includes('本地协议测试报告')&&document.querySelector('.retail-investigation-body')?.innerText.includes('只读 Reviewer 复核')`, kind+' approved-execution model report');
          await click('生成决策草稿');await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存草稿'&&!b.disabled)`, kind+' draft ready');await click('保存草稿');
          await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='提交模拟审批'&&!b.disabled)`, kind+' feasible draft');await click('提交模拟审批');await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='查看审批')`, kind+' request saved');await click('查看审批');
          await waitFor(`!!document.querySelector('textarea[aria-label="审批理由"]')`, kind+' approval ready');await js(`(()=>{const input=document.querySelector('textarea[aria-label="审批理由"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'核对三场景本地模拟执行');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('批准模拟方案');
          await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='查看模拟执行')`, kind+' approved');await click('查看模拟执行');await waitFor(`!!document.querySelector('input[aria-label="确认仅写本地模拟账本"]')`, kind+' executable');await js(`document.querySelector('input[aria-label="确认仅写本地模拟账本"]').click()`);await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行到模拟账本'&&!b.disabled)`,kind+' confirmed');await click('执行到模拟账本');await waitFor(`!!document.querySelector('[aria-label="模拟执行回执"]')&&document.querySelector('[aria-label="执行回读核对"]')?.innerText.includes('回读核对一致')`,kind+' successful receipt');await capture('simulation-'+kind+'.png');
        }
        await assert(`(async()=>{const jobs=(await window.electronAPI.retailRequest({op:'executions'})).data;const stock=jobs.find(e=>e.job.scenario==='inventory');const ads=jobs.find(e=>e.job.scenario==='ads');const rows=(await window.electronAPI.retailRequest({op:'signals'})).data.records;return jobs.filter(e=>e.status==='succeeded').length===3&&stock.current.values.pendingPurchaseQuantity===20&&ads.current.values.budgetMinor===90000&&rows.find(r=>r.source==='demo'&&r.kind==='inventory'&&r.row.sku_id==='TEA-500').metrics.available===40;})()`, 'all three UI workflows execute only isolated simulation and inventory is not received as sellable stock');
        await click('申请补偿');await fillText('补偿申请理由','取消本地未受理补货请求');await click('生成补偿申请');await waitFor(`!!document.querySelector('[aria-label="补偿重新审批"]')`, 'inventory compensation requires fresh approval');await approveCompensationUi();await assert(`document.querySelector('[aria-label="模拟补偿回执"]').innerText.includes('已取消')`, 'pending replenishment compensation cancels request instead of receiving inventory');await capture('compensation-inventory.png');
        await click('返回执行记录');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟预算'))`, 'execution list return');await js(`Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟预算')).click()`);await click('申请补偿');await fillText('补偿申请理由','恢复预算试验前的模拟值');await click('生成补偿申请');await waitFor(`!!document.querySelector('[aria-label="补偿重新审批"]')`, 'ads compensation pending');await fillText('补偿审批理由','先补充恢复理由');await click('驳回补偿');await waitFor(`document.querySelector('[aria-label="补偿审批结论"]')?.innerText.includes('已驳回')`, 'compensation rejection retained');await fillText('补偿修订理由','补充理由后重新申请恢复预算');await click('保存补偿新版本');await waitFor(`document.querySelector('[data-testid="retail-compensations"]').innerText.includes('补偿v2')&&!!document.querySelector('[aria-label="补偿重新审批"]')`, 'new compensation version needs renewed approval');await approveCompensationUi();await capture('compensation-budget.png');await click('重新核对补偿');await waitFor(`document.querySelector('[data-testid="retail-compensations"] [role="status"]')?.innerText.includes('补偿回读核对一致')`, 'manual compensation reread');
        await assert(`(async()=>{const records=(await window.electronAPI.retailRequest({op:'compensations'})).data;const c=records.find(v=>v.request.scenario==='ads');const forged=await window.electronAPI.retailRequest({op:'compensation_execute',id:c.request.id,expectedVersion:2,expectedActionHash:c.request.actionHash,actor:'admin'});const again=await window.electronAPI.retailRequest({op:'compensation_execute',id:c.request.id,expectedVersion:2,expectedActionHash:c.request.actionHash});const item=again.data.find(v=>v.request.id===c.request.id);const jobs=(await window.electronAPI.retailRequest({op:'executions'})).data;const stock=jobs.find(j=>j.job.scenario==='inventory');const ads=jobs.find(j=>j.job.scenario==='ads');const source=(await window.electronAPI.retailRequest({op:'signals'})).data.records;const draft=(await window.electronAPI.retailRequest({op:'decisions'})).data.find(d=>d.id===ads.job.decisionId);const exported=await window.electronAPI.retailRequest({op:'investigation_export',id:draft.investigationId,format:'json'});return !forged.ok&&again.ok&&item.receipt.id===c.receipt.id&&item.attempts.filter(a=>a.status==='succeeded').length===1&&stock.current.purchaseRequestStatus==='cancelled'&&stock.current.values.pendingPurchaseQuantity===0&&ads.current.values.budgetMinor===100000&&source.find(r=>r.source==='demo'&&r.kind==='inventory'&&r.row.sku_id==='TEA-500').metrics.available===40&&JSON.parse(exported.content).compensations[0].receipt.id===c.receipt.id;})()`, 'compensation is newly approved, idempotent, exportable, server scoped and isolated from source stock');
        await click('返回执行记录');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟商家券'))`, 'original margin execution list');await chooseExecution('调整模拟商家券');await click('申请补偿');await fillText('补偿申请理由','验证低毛利恢复阻断');await click('生成补偿申请');await waitFor(`document.querySelector('[aria-label="补偿阻断原因"]')?.innerText.includes('毛利下限')`, 'margin compensation must not bypass gross margin floor');await assert(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='批准补偿')`, 'unsafe compensation has no approval or execute action');await capture('compensation-blocked.png');
        // Every grouped action receives a new version and an independent approval through real IPC.
        const batchJobs=await js(`(async()=>{const ids=[];for(const scenario of ['ads','inventory']){const d=(await window.electronAPI.retailRequest({op:'decisions'})).data.find(v=>v.scenario===scenario);const updated=await window.electronAPI.retailRequest({op:'decision_revise',id:d.id,expectedVersion:d.version,kind:d.selectedKind,note:'独立批准的批次动作'});if(!updated.ok)throw new Error(updated.error);const latest=updated.data.find(v=>v.id===d.id);const submitted=await window.electronAPI.retailRequest({op:'decision_submit',id:d.id,expectedVersion:latest.version});if(!submitted.ok)throw new Error(submitted.error);const r=submitted.data.find(v=>v.id===d.id).request;const approved=await window.electronAPI.retailRequest({op:'approval_resolve',requestId:r.id,expectedVersion:latest.version,expectedActionHash:r.actionHash,choice:'approve',reason:'核对本次独立模拟动作'});if(!approved.ok)throw new Error(approved.error);ids.push(r.id);}return (await window.electronAPI.retailRequest({op:'executions'})).data.filter(v=>ids.includes(v.job.requestId)).map(v=>v.job);})()`);
        await click('执行记录');await click('执行批次');await waitFor(`document.querySelectorAll('input[aria-label^="选择批次动作"]').length===2`, 'two approved independent batch candidates');await js(`document.querySelectorAll('input[aria-label^="选择批次动作"]').forEach(i=>i.click())`);await fillText('批次说明','批次故障与部分成功演练');await click('保存执行批次');await waitFor(`!!document.querySelector('[aria-label="批次逐项结果"]')`, 'immutable batch created');
        const batch=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'execution_batches'});if(!r.ok)throw new Error(r.error);return r.data[0].batch;})()`);
        const lease=JSON.parse(testBun(`import {DecisionStore} from './packages/retail-domain/src/decisions';const store=new DecisionStore(${JSON.stringify(testDatabase())},${JSON.stringify(batch.workspaceId)},()=>[]);console.log(JSON.stringify(store.claimBatchItem(${JSON.stringify(batch.id)},${JSON.stringify(batch.items[0].jobId)},'ready',{id:'local-simulation-executor',role:'executor',environment:'simulation'})));process.exit(23);`,23));
        await click('刷新执行批次');await waitFor(`document.querySelector('[data-testid="retail-batches"]').innerText.includes('执行中')`, 'abandoned worker intent survives process exit');
        await waitFor(`Date.now()>=${JSON.stringify(Date.now()+16000)}`, 'lease deadline before recovery',22000);await click('刷新执行批次');await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='查询确认结果')`, 'unknown outcome is durable and not retried');await assert(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='继续待执行项').disabled`, 'unknown outcome disables resubmission');await capture('batch-unknown.png');await click('查询确认结果');await waitFor(`document.querySelector('[aria-label="批次逐项结果"]').innerText.includes('已确认未执行')`, 'fenced local ledger proof confirms not executed');
        const stockJob=batchJobs.find(j=>j.scenario==='inventory');testSql(`CREATE TRIGGER native_batch_failure BEFORE INSERT ON simulation_receipts WHEN NEW.job_id='${stockJob.id}' BEGIN SELECT RAISE(ABORT,'native isolated storage failure');END;`);
        await js(`document.querySelector('input[aria-label="确认批次逐项模拟执行"]').click()`);await click('继续待执行项');await waitFor(`document.querySelector('[data-testid="retail-batches"]').innerText.includes('部分成功')`, 'one item failure preserves independent success');await capture('batch-partial.png');
        const partial=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'execution_batches'});if(!r.ok)throw new Error(r.error);return r.data[0];})()`);const preserved=partial.items.find(i=>i.dispatch.status==='succeeded').receipt.id;testSql('DROP TRIGGER native_batch_failure');await js(`const box=document.querySelector('input[aria-label="确认批次逐项模拟执行"]');if(!box.checked)box.click()`);await click('仅重试该失败项');await waitFor(`document.querySelector('[data-testid="retail-batches"]').innerText.includes('全部成功')`, 'retry confirmed failure only');await capture('batch-success.png');
        await assert(`(async()=>{const b=(await window.electronAPI.retailRequest({op:'execution_batches'})).data[0];const jobs=(await window.electronAPI.retailRequest({op:'executions'})).data;const preserved=jobs.find(j=>j.receipt?.id===${JSON.stringify(preserved)});const forged=await window.electronAPI.retailRequest({op:'batch_run',id:b.batch.id,force:true});return !forged.ok&&b.status==='succeeded'&&b.items.every(i=>i.dispatch.status==='succeeded')&&preserved.attempts.length===1&&b.events.some(e=>e.event==='recovered_ready');})()`, 'batch recovery fences old intent and retry never duplicates successful item');
        await click('返回执行记录');await waitFor(`!!document.querySelector('[aria-label="模拟执行列表"]')`, 'execution list before review');await chooseExecution('调整模拟商家券');await waitFor(`document.querySelector('table[aria-label="模拟执行实际值"]')?.innerText.includes('¥15.00')`, 'margin receipt before review');await click('创建或查看复盘');await waitFor(`!!document.querySelector('[aria-label="复盘观察窗口"]')`, 'review freezes successful receipt');await js(`document.querySelector('input[aria-label="确认仅用于合成复盘"]').click()`);await click('载入合成观察回放');await waitFor(`!!document.querySelector('[aria-label="人工复盘复核"]')`, 'synthetic observation compare ready');await fillText('复盘结论','合成观察保持原值，不能据此判断优惠动作收益');await fillText('复盘干扰因素','同期活动未核实；没有真实经营观测或因果证据');await js(`document.querySelector('input[aria-label="确认复核不代表因果证明"]').click()`);await click('复核并保存 Case');await waitFor(`!!document.querySelector('[aria-label="已复核经营Case"]')`, 'reviewed Case saved');await capture('review-case.png');
        const review=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'reviews'});if(!r.ok)throw new Error(r.error);return r.data.find(v=>v.case);})()`);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigation_export',id:${JSON.stringify(review.review.investigationId)},format:'json'});if(!r.ok)return false;const bundle=JSON.parse(r.content);const forged=await window.electronAPI.retailRequest({op:'review_finalize',id:${JSON.stringify(review.review.id)},expectedVersion:2,observationHash:${JSON.stringify(review.review.observation.hash)},conclusion:'comparison_only',note:'伪造角色',confounders:'未知',actor:'local-simulation-reviewer'});return !forged.ok&&bundle.reviews.some(v=>v.case?.id===${JSON.stringify(review.case.id)})&&bundle.reviews.every(v=>v.review.clockBasis==='synthetic_business_date');})()`, 'review export retains Case evidence and rejects renderer role injection');
        await click('运行后续离线调查');await waitFor(`!!document.querySelector('[aria-label="调查历史Case"]')`, 'follow-up investigation page');
        const nextRun=await js(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigations'});if(!r.ok)throw new Error(r.error);return r.data.find(v=>v.caseContext?.some(c=>c.id===${JSON.stringify(review.case.id)}));})()`);
        await waitFor(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigations'});return r.ok&&r.data.some(v=>v.id===${JSON.stringify(nextRun.id)}&&v.state==='needs_evidence');})()`, 'later investigation consumes frozen historical Case through MCP',20000);
        await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'investigations'});const run=r.data.find(v=>v.id===${JSON.stringify(nextRun.id)});const context=run.trace.find(t=>t.tool==='retail_get_sku_context');return run.caseContext.length===1&&run.caseContext[0].id===${JSON.stringify(review.case.id)}&&context.transport==='mcp_stdio'&&context.data.historicalCases[0].id===${JSON.stringify(review.case.id)};})()`, 'Case retrieval is scoped, frozen and actually passed through desktop MCP');
        await click('执行记录');await waitFor(`!!document.querySelector('[aria-label="模拟执行列表"]')`, 'execution list before pending review');await chooseExecution('创建模拟补货请求');await waitFor(`document.querySelector('table[aria-label="模拟执行实际值"]')?.innerText.includes('待受理补货请求量')`, 'inventory receipt before review');await click('创建或查看复盘');await waitFor(`!!document.querySelector('[aria-label="复盘观察窗口"]')`, 'inventory review window');await js(`document.querySelector('input[aria-label="确认仅用于合成复盘"]').click()`);await click('载入合成观察回放');await waitFor(`!!document.querySelector('[aria-label="人工复盘复核"]')`, 'inventory observation stored');await assert(`(async()=>{const r=await window.electronAPI.retailRequest({op:'reviews'});const v=r.data.find(v=>v.review.job.scenario==='inventory');const future=v.review.windowEnd>=new Date(Date.now()+8*3600000).toISOString().slice(0,10);return v.state===(future?'awaiting_window':'ready')&&(!future||document.querySelector('[data-testid="retail-reviews"]').innerText.includes('观察窗口尚未结束'))&&Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='复核并保存 Case').disabled;})()`, 'inventory review follows its business window and requires explicit confirmation');await capture('review-pending.png');
        config.llmConnections=[];delete config.defaultLlmConnection;fs.writeFileSync(configPath,JSON.stringify(config,null,2));

      }
      if (failures.length) throw new Error(failures.join('\n'));
      finish();
    } catch (error) {await capture('native-failure.png').catch(()=>{}); finish(error); }
  });
});
try { require(path.join(root, 'apps/electron/dist/main.cjs')); } catch (error) { finish(error); }
