// Focused native UI acceptance: isolated profile, real preload/IPC/Bun/SQLite, no model calls.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts/signal-pagination', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, '.runtime/signal-pagination-'));
let application, page;
const checks = [];
function fixture(kind) {
  const [header, ...rows] = fs.readFileSync(path.join(root, `fixtures/retail/${kind}-demo.csv`), 'utf8').trim().split(/\r?\n/);
  const fields = header.split(',');
  const csv = [header, ...Array.from({ length: 65 }, (_, i) => {
    const row = rows[i % rows.length].split(',');
    row[fields.indexOf('sku_id')] = `PAGE-${String(i).padStart(3, '0')}`;
    row[fields.indexOf('shop_id')] = i === 64 ? 'tail-only-shop' : 'page-shop';
    return row.join(',');
  })].join('\n');
  return { csv, mapping: Object.fromEntries(fields.map(f => [f, f])) };
}
async function request(input) {
  const reply = await page.evaluate(input => window.electronAPI.retailRequest(input), input);
  assert.equal(reply.ok, true, reply.error); return reply;
}
async function main() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'apps/electron')], cwd: root, env, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(20000);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  const started = page.getByRole('button', { name: /^(Get Started|开始使用)$/ });
  const retailOnly = page.getByRole('button', { name: '仅使用经营分析', exact: true });
  const defer = page.getByRole('button', { name: /^(Setup later|稍后设置)$/ });
  await expect.poll(async () => await started.count() || await retailOnly.count() || await defer.count() || await page.locator('[data-focus-zone="sidebar"]').count(), { timeout: 30000 }).toBeGreaterThan(0);
  if (await retailOnly.count()) await retailOnly.click();
  if (await started.count()) { await started.click(); await expect(defer).toBeVisible(); }
  if (await defer.count()) await defer.click();
  await expect(page.locator('[data-focus-zone="sidebar"]')).toBeAttached();
  await page.getByRole('button', { name: '经营分析', exact: true }).click();
  await expect(page.getByTestId('retail-workspace')).toBeVisible();
  for (const kind of ['inventory', 'ads']) await request({ op: 'signals_import', kind, ...fixture(kind) });
  await page.getByRole('button', { name: '库存与广告', exact: true }).click();
  await page.getByLabel('数据来源', { exact: true }).selectOption('csv');
  const inventory = page.getByTestId('signals-inventory'), ads = page.getByTestId('signals-ads');
  await expect(inventory.getByRole('row')).toHaveCount(31);
  await expect(ads.getByRole('row')).toHaveCount(31);
  await expect(inventory).toContainText('1–30 / 65');
  await expect(page.getByRole('button', { name: /^异常中心/ })).toContainText('86');
  await expect.poll(() => page.getByLabel('店铺', { exact: true }).locator('option').allTextContents()).toContain('tail-only-shop');
  checks.push('real IPC bounds both tables to 30 rows; full anomaly count and off-page shop facet remain visible');

  await inventory.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(inventory).toContainText('31–60 / 65');
  await expect(ads).toContainText('1–30 / 65');
  await inventory.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(inventory).toContainText('61–65 / 65');
  await expect(inventory.getByRole('row')).toHaveCount(6);
  await expect(inventory.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  // Electron exposes native downloads through its Session, not Playwright's browser download event.
  const downloadFile = path.join(out, 'inventory-current-page.json');
  await application.evaluate(({ session }, target) => {
    globalThis.signalPaginationDownload = null;
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(target);
      item.once('done', (_event, state) => { globalThis.signalPaginationDownload = state; });
    });
  }, downloadFile);
  await inventory.getByRole('button', { name: '导出当前页证据', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.signalPaginationDownload)).toBe('completed');
  const exported = JSON.parse(fs.readFileSync(downloadFile, 'utf8'));
  assert.equal(exported.records.length, 5); assert.equal(exported.pagination.total, 65);
  checks.push('independent scene offsets, last-page boundary and explicitly bounded page export');

  await page.getByLabel('搜索库存或广告', { exact: true }).fill('PAGE-064');
  await expect(inventory).toContainText('1–1 / 1'); await expect(ads).toContainText('1–1 / 1');
  await expect(inventory.getByRole('row')).toHaveCount(2);
  await expect(page.getByTestId('retail-signals')).toContainText('库存预警 22 条');
  await expect(page.getByTestId('retail-signals')).toContainText('广告预警 22 条');
  // A rapid second filter must not leave the first request's rows displayed.
  await page.getByLabel('搜索库存或广告', { exact: true }).fill('PAGE-000');
  await page.getByLabel('搜索库存或广告', { exact: true }).fill('NO-SUCH-SKU');
  await expect(inventory).toContainText('0–0 / 0'); await expect(ads).toContainText('0–0 / 0');
  await expect(inventory.getByRole('row')).toHaveCount(0);
  await page.getByLabel('搜索库存或广告', { exact: true }).fill('');
  await expect(inventory).toContainText('1–30 / 65');
  await page.getByLabel('库存广告状态', { exact: true }).selectOption('warning');
  await expect(inventory).toContainText('1–22 / 22'); await expect(ads).toContainText('1–22 / 22');
  checks.push('search/status reset pagination, scope counts stay complete and stale filter responses do not render');

  await page.getByLabel('库存广告状态', { exact: true }).selectOption('all');
  await page.getByLabel('店铺', { exact: true }).selectOption('tail-only-shop');
  await expect(inventory).toContainText('1–1 / 1'); await expect(ads).toContainText('1–1 / 1');
  await page.getByLabel('店铺', { exact: true }).selectOption('');
  await expect(inventory).toContainText('1–30 / 65');
  await inventory.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(inventory).toContainText('31–60 / 65');
  await page.getByRole('button', { name: '刷新经营数据', exact: true }).click();
  await expect(inventory).toContainText('1–30 / 65');
  await page.getByRole('button', { name: /^异常中心/ }).click();
  await expect(inventory).toContainText('1–30 / 43');
  await expect(ads).toContainText('1–30 / 43');
  checks.push('off-page facet selection, explicit refresh reset and anomaly-center pagination use actual bounded requests');
  await page.screenshot({ path: path.join(out, 'pagination.png'), fullPage: true });
}
main().then(() => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, profile, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, out }));
}).catch(async error => {
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, checks, profile, error: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  await page?.context().tracing.stop({ path: path.join(out, 'trace.zip') }).catch(() => {});
  await application?.close();
});
