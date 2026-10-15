// Native Electron integration test: actual renderer actions, preload, IPC, Bun and SQLite.
const { app, nativeTheme } = require('electron');
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
let finished = false;
function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  const result = { ok: !error, phase, checks, profile, error: error?.stack || null, failures };
  fs.writeFileSync(path.join(out, `e2e-${phase}.json`), JSON.stringify(result, null, 2));
  console.log('M1_E2E ' + JSON.stringify(result)); app.exit(error ? 1 : 0);
}
const timeout = setTimeout(() => finish(new Error('M1 UI test exceeded 55 seconds')), 55000);
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
    try {
      await waitFor(`!!document.querySelector('[data-focus-zone="sidebar"]') || /Get Started|开始使用|Setup later|稍后设置/.test(document.body.innerText)`, 'native desktop or welcome');
      if (!await js(`!!document.querySelector('[data-focus-zone="sidebar"]')`)) {
        await js(`Array.from(document.querySelectorAll('button')).find(el => /^(Get Started|开始使用)$/.test(el.textContent.trim()))?.click()`);
        await waitFor(`/Setup later|稍后设置/.test(document.body.innerText)`, 'defer model setup');
        await js(`Array.from(document.querySelectorAll('button')).find(el => /^(Setup later|稍后设置)$/.test(el.textContent.trim())).click()`);
      }
      await waitFor(`!!document.querySelector('[data-focus-zone="sidebar"]')`, 'original desktop shell');
      await assert(`!document.querySelector('[data-testid="retail-workspace"]') && !document.querySelector('.retail-back-to-business')`, 'startup preserves original desktop workspace');
      await capture('desktop-shell.png');
      await click('经营分析');
      await waitFor(`!!document.querySelector('[data-testid="retail-workspace"]') && !document.body.innerText.includes('正在读取本机')`, 'retail page');
      await assert(`!!document.querySelector('[data-focus-zone="sidebar"]') && !document.querySelector('.retail-nav') && !!document.querySelector('[data-panel-role="workspace-tool"]')`, 'retail analysis shares native sidebar and panel chrome');
      if (phase === 'restart') {
        await assert(`document.querySelectorAll('tbody tr').length === 6`, 'demo survives application restart');
        await js(`(() => { const select = document.querySelector('select[aria-label="数据来源"]'); select.value='csv'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 1`, 'persisted CSV row');
        await assert(`document.body.innerText.includes('33.33%') && document.body.innerText.includes('¥90.00')`, 'corrected margin survives application restart');
      } else {
        await waitFor(`document.body.innerText.includes('从一组可核对的经营数据开始')`, 'empty state');
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
        await js(`Array.from(document.querySelectorAll('nav button')).find(el=>el.textContent.includes('异常中心')).click()`);
        await waitFor(`document.querySelectorAll('tbody tr').length === 4`, 'anomaly-only view');
        checks.push('anomaly center excludes the two normal rows');
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
      }
      if (failures.length) throw new Error(failures.join('\n'));
      finish();
    } catch (error) { finish(error); }
  });
});
try { require(path.join(root, 'apps/electron/dist/main.cjs')); } catch (error) { finish(error); }
