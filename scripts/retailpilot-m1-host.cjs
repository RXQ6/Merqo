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
const timeout = setTimeout(() => finish(new Error('Retail UI test exceeded 55 seconds')), 55000);
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('preload-error', (_event, _preload, error) => failures.push(error.message));
  contents.on('did-finish-load', async () => {
    if (!contents.getURL().includes('renderer/index.html')) return;
    const js = code => contents.executeJavaScript(code);
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
    const click = text => js(`(() => { const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); button.click(); })()`);
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
        await assert(`document.body.innerText.includes('离线规则演示，未调用模型') && document.body.innerText.includes('20.00%')`, 'persisted offline report is labeled and retains calculations');
        await click('返回经营总览');

        await js(`(() => { const select = document.querySelector('select[aria-label="数据来源"]'); select.value='csv'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 1`, 'persisted CSV row');
        await assert(`document.body.innerText.includes('33.33%') && document.body.innerText.includes('¥90.00')`, 'corrected margin survives application restart');
        await click('库存与广告');
        await waitFor(`document.querySelectorAll('[data-testid="signals-inventory"] tbody tr').length===1 && document.querySelectorAll('[data-testid="signals-ads"] tbody tr').length===1`, 'persisted scenario CSV rows');
        await assert(`document.querySelector('[data-testid="signals-inventory"]').innerText.includes('990') && document.querySelector('[data-testid="signals-ads"]').innerText.includes('4.00 / 3.00')`, 'inventory and advertising corrections survive restart');

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
            const system = request.messages[0].content;
            const context = JSON.parse(request.messages[1].content);
            const toolNames = ['retail_get_data_health','retail_get_sku_context','retail_get_promotions','retail_simulate_actions'];
            let output;
            if (system.includes('串行只读 Reviewer')) output = {verdict:'passed', notes:['本地协议测试复核，非真实模型质量验证']};
            else if (context.observations.length < 4) output = {tool:toolNames[context.observations.length]};
            else output = {report:{summary:'本地协议测试报告，非真实模型生成的业务结论',observations:[{text:'单位收入70元、商品毛利10元、毛利率14.29%',evidenceIds:[context.observations[2].evidenceId]}],hypotheses:[],unknowns:['缺少实时数据'],alternatives:['成本或优惠分摊口径可能错误'],options:[{kind:'observe',rationale:'补证后再决定'},{kind:'reduce_coupon',rationale:'仅作条件测算'}]}};
            res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
          } catch(e) { failures.push(e.message); res.statusCode=500; res.end('{}'); }
        });
        await new Promise(resolve => contractServer.listen(0,'127.0.0.1',resolve));
        const configPath = path.join(profile,'config/config.json');
        const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
        config.llmConnections = [{slug:'m2-contract',name:'本地协议测试（非真实模型）',providerType:'pi_compat',authType:'none',createdAt:Date.now(),baseUrl:`http://127.0.0.1:${contractServer.address().port}/v1`,defaultModel:'contract-fixture',customEndpoint:{api:'openai-completions'}}];
        config.defaultLlmConnection='m2-contract'; fs.writeFileSync(configPath,JSON.stringify(config,null,2));
        await click('重新进行模型调查');
        await waitFor(`document.body.innerText.includes('本地协议测试报告') && document.body.innerText.includes('只读 Reviewer 复核')`, 'model transport and bounded tool loop');
        if (contractCalls !== 6) throw new Error('Expected 5 model decisions and one reviewer call, got '+contractCalls);
        await capture('investigation-contract.png');
        checks.push('real inference adapter executes six local HTTP contract calls with no native tool authority');
        config.llmConnections=[]; delete config.defaultLlmConnection; fs.writeFileSync(configPath,JSON.stringify(config,null,2));
        await click('运行离线规则演示');
        await waitFor(`document.body.innerText.includes('离线规则演示，未调用模型') && document.body.innerText.includes('方案比较（代码测算）')`, 'explicit offline replay');
        await assert(`document.querySelectorAll('table[aria-label="调查方案比较"] tbody tr').length === 2 && document.body.innerText.includes('20.00%') && document.body.innerText.includes('14.29%')`, 'two deterministic scenarios and evidence are displayed');
        await capture('investigation-replay.png');
        await assert(`(await window.electronAPI.retailRequest({op:'investigation_update',id:'forged',report:{}})).ok === false`, 'renderer cannot forge investigation completion');
        checks.push('explicit offline replay remains distinct from model investigation');
        await click('返回经营总览');

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

      }
      if (failures.length) throw new Error(failures.join('\n'));
      finish();
    } catch (error) { finish(error); }
  });
});
try { require(path.join(root, 'apps/electron/dist/main.cjs')); } catch (error) { finish(error); }
