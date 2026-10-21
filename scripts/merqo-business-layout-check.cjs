// Walk real Electron pages in an existing isolated synthetic acceptance profile.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), profile = path.resolve(process.env.MERQO_PREVIEW_PROFILE || '');
assert(profile.startsWith(path.join(root, '.runtime', 'ingestion-ui-')), 'Only isolated acceptance profiles are allowed');
const config = JSON.parse(fs.readFileSync(path.join(profile, 'config/config.json'), 'utf8'));
const workspace = config.workspaces[0];
const out = path.join(root, 'artifacts/business-layout', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
let app, page; const checks = [], errors = [];
const routes = ['经营总览', '异常中心', '库存与补货', '广告经营', '交易与退款', '经营助手', '调查记录', '经营巡检', '经营复盘', '决策草稿', '审批中心', '执行记录', '补偿记录', '平台接入', '数据与导入', '商品映射', '经营规则'];
const nav = () => page.getByRole('navigation', { name: '经营导航', exact: true });
async function go(name) {
  await nav().getByRole('button', { name: name === '异常中心' ? /^异常中心/ : name, exact: name !== '异常中心' }).click();
  await expect(page.getByRole('main', { name: '经营工作区' }).getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main').getByText(/正在读取|正在加载|读取中|正在处理…/)).toHaveCount(0);
}
async function geometry(name, width) {
  await expect.poll(() => page.getByRole('main', { name: '经营工作区' }).evaluate(el => el.scrollWidth - el.clientWidth), { message: `${name} must not overflow the page at ${width}` }).toBeLessThanOrEqual(1);
  const h1 = page.getByRole('main').getByRole('heading', { level: 1 });
  await expect(h1).toBeInViewport();
  const measure = await h1.evaluate(el => { const main=el.closest('main'); return {title:el.textContent, size:getComputedStyle(el).fontSize, inset:Math.round(el.getBoundingClientRect().left-main.getBoundingClientRect().left)}; });
  assert.equal(measure.size, '22px'); assert(measure.inset >= 18 && measure.inset <= 32, `${name}: title alignment ${measure.inset}`);
  checks.push({ page: name, width, ...measure });
}
async function main() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'apps/electron')], cwd: root, env, timeout: 60000 });
  await expect.poll(() => app.windows().some(p => { try { return new URL(p.url()).searchParams.get('workspaceId') === workspace.id; } catch { return false; } })).toBe(true);
  page = app.windows().find(p => { try { return new URL(p.url()).searchParams.get('workspaceId') === workspace.id; } catch { return false; } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  const entry = page.getByRole('button', { name: '经营分析', exact: true });
  if (!await page.getByTestId('retail-workspace').isVisible()) { await expect(entry).toBeVisible(); await entry.click(); }
  await expect(page.getByTestId('retail-workspace')).toBeVisible();
  const call = input => page.evaluate(input => window.electronAPI.retailRequest(input), input);
  const query = { op: 'transactions_page', source: 'csv', startDate: '2026-10-01', endDate: '2026-10-31', basis: 'event', shop: '', channel: '', offset: 0, limit: 100 };
  const before = await call(query); assert(before.ok);
  const window = await app.browserWindow(page);
  for (const width of [1440, 800]) {
    await window.evaluate((w, width) => w.setSize(width, 1000), width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(width);
    for (const [index, name] of routes.entries()) {
      await go(name); await geometry(name, width);
      if (name === '库存与补货') {
        await expect(page.getByTestId('signals-inventory')).toBeVisible();
        await expect(page.getByTestId('signals-ads')).toHaveCount(0);
        await expect(page.getByRole('region', { name: '广告退款后归因核对', exact: true })).toHaveCount(0);
        await expect(page.getByLabel('场景导入类型', { exact: true })).toHaveValue('inventory');
      }
      if (name === '广告经营') {
        await expect(page.getByTestId('signals-ads')).toBeVisible();
        await expect(page.getByTestId('signals-inventory')).toHaveCount(0);
        await expect(page.getByRole('region', { name: '仓库收发存与调拨', exact: true })).toHaveCount(0);
        await expect(page.getByLabel('场景导入类型', { exact: true })).toHaveValue('ads');
      }
      await page.screenshot({ path: path.join(out, `${width}-${String(index + 1).padStart(2, '0')}.png`) });
    }
    await go('执行记录'); await page.getByRole('button', { name: '执行批次', exact: true }).click(); await geometry('执行批次', width);
    await page.screenshot({ path: path.join(out, `${width}-18.png`) });
    for (const [scene, action, heading] of [
      ['库存与补货', '仓库与调拨', '仓库收发存与调拨'],
      ['广告经营', '广告退款归因', '广告退款后归因核对'],
      ['交易与退款', '订单分摊', '订单优惠分摊'],
      ['交易与退款', '促销与赠品', '促销资格与赠品成本'],
    ]) {
      await go(scene);
      const shortcut = page.getByRole('navigation', { name: '当前页面功能定位', exact: true }).getByRole('button', { name: action, exact: true });
      await shortcut.click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
      await page.screenshot({ path: path.join(out, `${width}-${action}.png`) });
    }
  }
  await go('经营助手'); await page.getByRole('button', { name: '查看广告经营', exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name: '广告经营', exact: true })).toBeVisible();
  // Opening import from overview must keep the file input alive across the route change.
  await go('经营总览');
  const chooserReady = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入毛利 CSV', exact: true }).click();
  const chooser = await chooserReady;
  await chooser.setFiles(path.join(root, 'fixtures/retail/demo-operations.csv'));
  await expect(page.getByRole('region', { name: '导入预览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭导入预览', exact: true }).click();
  await go('经营助手'); await page.getByRole('button', { name: '打开高级工作台', exact: true }).click();
  await expect(entry).toBeVisible(); await expect(page.getByText('整理通用会话、资料与自动化。经营审批请进入经营分析。', { exact: true })).toBeVisible();
  await entry.click(); await expect(page.getByTestId('retail-workspace')).toBeVisible();
  const after = await call(query); assert(after.ok); assert.deepEqual(after.data.totals, before.data.totals); assert.equal(after.data.total, before.data.total);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, shortcuts: 8, assistantLinks: true, overviewImport: true, advancedRoundTrip: true, ledgerUnchanged: true, syntheticOnly: true, realPlatformCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, pages: checks.length, out }));
}
main().catch(async error => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, checks, errors, error: error.stack }, null, 2));
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); console.error(error); process.exitCode = 1;
}).finally(async () => { await page?.context().tracing.stop({ path: path.join(out, 'trace.zip') }).catch(() => {}); await app?.close(); });
