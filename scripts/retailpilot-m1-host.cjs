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
let contractServer; let contractCalls = 0;
let finished = false;
function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  const result = { ok: !error, phase, checks, profile, error: error?.stack || null, failures };
  fs.writeFileSync(path.join(out, `e2e-${phase}.json`), JSON.stringify(result, null, 2));
  console.log('M1_E2E ' + JSON.stringify(result)); app.exit(error ? 1 : 0);
}
const timeout = setTimeout(() => finish(new Error('Retail UI test exceeded 180 seconds')), 180000);
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('preload-error', (_event, _preload, error) => failures.push(error.message));
  contents.on('did-finish-load', async () => {
    if (!contents.getURL().includes('renderer/index.html')) return;
    const js = async code => {try{return await contents.executeJavaScript(code);}catch(error){const body=await contents.executeJavaScript('document.body.innerText').catch(()=>'(unavailable)');throw new Error(error.message+'\nExpression: '+code.slice(0,1200)+'\nPage: '+body);}};
    const downloads = [];
    contents.session.on('will-download', (_event, item) => { const target = path.join(out, item.getFilename()); item.setSavePath(target); item.once('done', (_event, state) => downloads.push({ target, state })); });
    const capture = async name => {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(out, name), (await contents.capturePage()).toPNG());
    };
    async function waitFor(expression, label) {
      const start = Date.now();
      while (Date.now() - start < 12000) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out: ' + label + '\n' + await js('document.body.innerText'));
    }
    const assert = async (expression, label) => { if (!await js(`(async () => (${expression}))()`)) throw new Error(label); checks.push(label); };
    const click = async text => {await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,text+' enabled');return js(`(() => { const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); button.click(); })()`);};
    const fillText=async(label,value)=>{await waitFor(`!!document.querySelector('textarea[aria-label="${label}"]')`,label+' ready');await js(`(()=>{const input=document.querySelector('textarea[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
    const approveCompensationUi=async()=>{await fillText('补偿审批理由','核对原回执、当前状态和补偿约束');await click('批准补偿');await waitFor(`!!document.querySelector('input[aria-label="确认执行本地模拟补偿"]')`, 'new compensation approved');await js(`document.querySelector('input[aria-label="确认执行本地模拟补偿"]').click()`);await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行模拟补偿'&&!b.disabled)`, 'compensation confirmed');await click('执行模拟补偿');await waitFor(`!!document.querySelector('[aria-label="模拟补偿回执"]')&&document.querySelector('[aria-label="补偿回读记录"]')?.innerText.includes('补偿回读核对一致')`, 'compensation receipt and reread');};
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
      await assert(`!document.querySelector('[data-testid="retail-workspace"]') && !document.querySelector('.retail-back-to-business')`, 'startup preserves original desktop workspace');
      const desktopWindow = BrowserWindow.fromWebContents(contents);
      if (Math.abs(desktopWindow.getContentBounds().height - desktopWindow.getBounds().height) > 2) throw new Error('Separate Windows title strip still occupies client height');
      if (!desktopWindow.isMinimizable() || !desktopWindow.isMaximizable() || !desktopWindow.isClosable()) throw new Error('Native caption capabilities missing');
      checks.push('Windows separate title strip removed while caption capabilities remain enabled');
      await capture('desktop-shell.png');
      await click('经营分析');
      await waitFor(`!!document.querySelector('[data-testid="retail-workspace"]') && !document.body.innerText.includes('正在读取本机')`, 'retail page');
      await assert(`!!document.querySelector('[data-focus-zone="sidebar"]') && !document.querySelector('.retail-nav') && !!document.querySelector('[data-panel-role="workspace-tool"]')`, 'retail analysis shares native sidebar and panel chrome');
      if (phase === 'restart') {
        await assert(`document.querySelectorAll('tbody tr').length === 6`, 'demo survives application restart');
        await click('调查记录');
        await waitFor(`document.body.innerText.includes('方案比较（代码测算）')`, 'investigation report survives restart');
        await js(`Array.from(document.querySelectorAll('.retail-investigation-list button')).find(b=>b.innerText.includes('离线演示')).click()`);await waitFor(`document.body.innerText.includes('离线规则演示，未调用模型')`, 'offline report selected after restart');await assert(`document.body.innerText.includes('离线规则演示，未调用模型') && document.querySelectorAll('.retail-investigation-list button').length>=7`, 'all three scenario histories survive restart');
        await js(`Array.from(document.querySelectorAll('.retail-investigation-list button')).find(el=>el.innerText.includes('促销毛利调查') && el.innerText.includes('离线演示')).click()`);
        await assert(`document.body.innerText.includes('20.00%')`, 'legacy margin report retains calculations');
        await click('返回经营总览');

        await js(`(() => { const select = document.querySelector('select[aria-label="数据来源"]'); select.value='csv'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 1`, 'persisted CSV row');
        await assert(`document.body.innerText.includes('33.33%') && document.body.innerText.includes('¥90.00')`, 'corrected margin survives application restart');
        await click('库存与广告');
        await waitFor(`document.querySelectorAll('[data-testid="signals-inventory"] tbody tr').length===1 && document.querySelectorAll('[data-testid="signals-ads"] tbody tr').length===1`, 'persisted scenario CSV rows');
        await assert(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('990') && document.querySelector('[data-testid="signals-ads"]').innerText.includes('4.00 / 3.00')`, 'inventory and advertising corrections survive restart');

        await click('决策草稿');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="决策草稿列表"] button')).find(b=>b.textContent.includes('v2'))`, 'margin draft list');await js(`Array.from(document.querySelectorAll('[aria-label="决策草稿列表"] button')).find(b=>b.textContent.includes('v2')).click()`);await waitFor(`document.body.innerText.includes('v2 已驳回')`, 'decision version and rejection persist across restart');await click('查看版本记录');await waitFor(`document.querySelector('[aria-label="决策版本记录"]')?.innerText.includes('已被新版本替代')`, 'decision request history persists across restart');checks.push('versioned draft and superseded approval request survive restart');
        await click('审批中心');await waitFor(`!!document.querySelector('select[aria-label="审批状态筛选"]')`, 'approval inbox after restart');
        await js(`(()=>{const select=document.querySelector('select[aria-label="审批状态筛选"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="审批申请列表"] button')).find(b=>b.textContent.includes('v2'))`, 'rejected approval list');await js(`Array.from(document.querySelectorAll('[aria-label="审批申请列表"] button')).find(b=>b.textContent.includes('v2')).click()`);await waitFor(`document.querySelector('[aria-label="审批结论"]')?.innerText.includes('还需核对成本口径')`, 'approval resolution and reason survive restart');
        await assert(`document.querySelector('[data-testid="retail-approvals"]').innerText.includes('已被新版本替代')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='批准模拟方案')`, 'superseded approval is visible and rejected decision cannot be approved again');

        await click('执行记录');await waitFor(`!!document.querySelector('[aria-label="模拟执行回执"]')`, 'simulation receipt persists after restart');await js(`Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟商家券')).click()`);await waitFor(`document.querySelector('table[aria-label="模拟执行实际值"]')?.innerText.includes('¥15.00')`, 'margin receipt selected');await assert(`document.querySelector('table[aria-label="模拟执行实际值"]').innerText.includes('¥15.00')&&document.querySelector('[aria-label="执行回读核对"]').innerText.includes('回读核对一致')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='执行到模拟账本')`, 'successful simulation and reconciliation survive restart without another execution');
        await click('补偿记录');await waitFor(`!!document.querySelector('[aria-label="补偿申请列表"]')&&document.querySelector('[aria-label="补偿申请列表"]').innerText.includes('恢复模拟预算')`, 'compensation records after restart');await js(`Array.from(document.querySelectorAll('[aria-label="补偿申请列表"] button')).find(b=>b.innerText.includes('恢复模拟预算')).click()`);await waitFor(`!!document.querySelector('[aria-label="模拟补偿回执"]')`, 'compensation receipt persisted');await js(`document.querySelector('[aria-label="补偿版本记录"] > summary').click()`);await assert(`document.querySelector('table[aria-label="补偿实际结果"]').innerText.includes('¥1000.00')&&document.querySelector('[aria-label="补偿回读记录"]').innerText.includes('补偿回读核对一致')&&document.querySelector('[aria-label="补偿版本记录"]').innerText.includes('先补充恢复理由')&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='执行模拟补偿')`, 'compensation receipt, reread, rejected history and no repeat action survive restart');
      } else {
        await waitFor(`document.body.innerText.includes('从一组可核对的经营数据开始')`, 'empty state');
        await waitFor(`!!Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='载入演示数据'&&!el.disabled)`, 'demo action ready');
        await click('载入演示数据');
        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'demo rows');
        await assert(`document.body.innerText.includes('¥7,125.00') && document.body.innerText.includes('¥1,765.00')`, 'demo totals match independently calculated revenue and gross profit');
        await capture('overview.png');
        nativeTheme.themeSource = 'dark';
        await waitFor(`document.documentElement.classList.contains('dark')`, 'desktop dark theme');
        await assert(`getComputedStyle(document.querySelector('.retail-app')).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || getComputedStyle(document.querySelector('.retail-app')).getPropertyValue('--paper').trim() === getComputedStyle(document.documentElement).getPropertyValue('--background').trim()`, 'retail content inherits desktop background token');
        await capture('overview-dark.png');
        nativeTheme.themeSource = 'light';
        await waitFor(`document.documentElement.classList.contains('light')`, 'desktop light theme');
        await click('返回会话');
        await waitFor(`!document.querySelector('[data-testid="retail-workspace"]')`, 'return to original sessions');
        await click('经营分析');
        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'reopen retail preserves data');
        checks.push('native desktop and retail navigation round trip retains persisted data');
        await js(`Array.from(document.querySelectorAll('[data-focus-zone="sidebar"] button')).find(el => /^(所有会话|All Sessions)/.test(el.textContent.trim())).click()`);
        await waitFor(`!document.querySelector('[data-testid="retail-workspace"]')`, 'native sidebar leaves analysis even when session route is unchanged');
        await click('经营分析');
        await waitFor(`document.querySelectorAll('tbody tr').length === 6`, 'native sidebar reopens analysis');
        checks.push('original sidebar navigation remains usable');
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
            if (system.includes('串行只读 Reviewer')) output = {verdict:'passed', notes:['本地协议测试复核，非真实模型质量验证']};
            else if (context.observations.length < 4) output = {tool:toolNames[context.observations.length]};
            else output = {report:{summary:'本地协议测试报告，非真实模型生成的业务结论',observations:[{text:context.scenario ? '本地场景协议检查，经营事实以工具证据为准' : '单位收入70元、商品毛利10元、毛利率14.29%',evidenceIds:[context.observations[2].evidenceId]}],hypotheses:[],unknowns:['缺少实时数据'],alternatives:['成本或优惠分摊口径可能错误'],options:[{kind:'observe',rationale:'补证后再决定'},{kind:context.scenario === 'inventory' ? 'replenish_draft' : context.scenario === 'ads' ? 'reduce_budget' : 'reduce_coupon',rationale:'仅作条件测算'}]}};
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
        checks.push('real inference adapter executes six local HTTP contract calls with no native tool authority');
        await assert(`(await window.electronAPI.retailRequest({op:'investigations'})).data.filter(r=>r.state==='completed').every(r=>r.trace.filter(t=>t.stage==='investigate').length===4&&r.trace.filter(t=>t.stage==='investigate').every(t=>t.transport==='mcp_stdio'))`, 'desktop investigation uses four actual MCP stdio tool calls');
        await click('导出报告与证据 JSON');
        await waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='导出 Markdown')?.disabled`, 'JSON export request ready');
        const exportDeadline = Date.now()+10000; while(downloads.length<1&&Date.now()<exportDeadline)await new Promise(r=>setTimeout(r,100));
        if(downloads.length!==1||downloads[0].state!=='completed')throw new Error('JSON export did not complete');
        const exported=JSON.parse(fs.readFileSync(downloads[0].target,'utf8'));
        if(exported.evidenceIndex.length!==4||!exported.evidenceIndex.every(e=>e.transport==='mcp_stdio')||!exported.investigation.evidence.snapshotHash)throw new Error('Exported evidence/provenance incomplete');
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
        await click('返回执行记录');await waitFor(`!!Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟商家券'))`, 'original margin execution list');await js(`Array.from(document.querySelectorAll('[aria-label="模拟执行列表"] button')).find(b=>b.innerText.includes('调整模拟商家券')).click()`);await click('申请补偿');await fillText('补偿申请理由','验证低毛利恢复阻断');await click('生成补偿申请');await waitFor(`document.querySelector('[aria-label="补偿阻断原因"]')?.innerText.includes('毛利下限')`, 'margin compensation must not bypass gross margin floor');await assert(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='批准补偿')`, 'unsafe compensation has no approval or execute action');await capture('compensation-blocked.png');
        config.llmConnections=[];delete config.defaultLlmConnection;fs.writeFileSync(configPath,JSON.stringify(config,null,2));

      }
      if (failures.length) throw new Error(failures.join('\n'));
      finish();
    } catch (error) {await capture('native-failure.png').catch(()=>{}); finish(error); }
  });
});
try { require(path.join(root, 'apps/electron/dist/main.cjs')); } catch (error) { finish(error); }
