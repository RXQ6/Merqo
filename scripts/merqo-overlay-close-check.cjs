// Real Electron regression: overlay dismissal must never hit native caption buttons.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(root, '.runtime/overlay-close-'));
const workspace = path.join(profile, 'config/workspaces/acceptance'), id = randomUUID();
const out = path.join(root, 'artifacts/overlay-close', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(profile, 'config/config.json'), JSON.stringify({ workspaces: [{ id, rootPath: workspace, name: '弹窗关闭验收', slug: 'acceptance', createdAt: Date.now() }], activeWorkspaceId: id, setupDeferred: true }));
fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ id, name: '弹窗关闭验收', slug: 'acceptance', createdAt: Date.now(), updatedAt: Date.now() }));
let app, page; const checks = [];
async function main() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.MERQO_TEST_EXE;
  app = await electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [path.join(root, 'apps/electron')], cwd: executable ? profile : root, env, timeout: 60000 });
  await app.firstWindow();
  await expect.poll(() => app.windows().some(p => p.url().includes(`workspaceId=${id}`)), { timeout: 30000 }).toBe(true);
  page = app.windows().find(p => p.url().includes(`workspaceId=${id}`)); page.setDefaultTimeout(30000);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await expect.poll(async () => await page.getByRole('button', { name: /^(Get Started|开始使用|Setup later|稍后设置|仅使用经营分析)$/ }).count() || await page.locator('[data-focus-zone="sidebar"]').count() || await page.getByTestId('retail-workspace').count(), { timeout: 30000 }).toBeGreaterThan(0);
  for (const name of [/^仅使用经营分析$/, /^(Get Started|开始使用)$/, /^(Setup later|稍后设置)$/]) {
    const button = page.getByRole('button', { name }); if (await button.count()) await button.click();
  }
  const advanced = page.getByRole('button', { name: '高级工作台', exact: true });
  await expect.poll(async () => await advanced.isVisible() || await page.getByRole('button', { name: /^(最新动态|What.s New)$/ }).isVisible(), { timeout: 30000 }).toBe(true);
  if (await advanced.isVisible()) await advanced.click();
  const open = page.getByRole('button', { name: /^(最新动态|What.s New)$/ });
  await expect(open).toBeVisible();
  const win = await app.browserWindow(page);
  for (const mode of ['normal', 'narrow', 'maximized']) {
    await win.evaluate((w, mode) => { w.unmaximize(); w.setSize(mode === 'narrow' ? 800 : 1440, 900); if (mode === 'maximized') w.maximize(); }, mode);
    await open.click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: /关闭.*Esc|Close.*Esc/i });
    await expect(close).toBeVisible();
    const box = await close.boundingBox(); assert(box && box.y >= 48, 'Overlay close must be below native Windows caption area');
    await page.screenshot({ path: path.join(out, `${mode}.png`) });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(dialog).toHaveCount(0); assert(!page.isClosed());
    assert(await win.evaluate(w => !w.isDestroyed()));
    await open.click(); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    checks.push({ mode, closeButtonY: box.y, pointerDismissed: true, escapeDismissed: true, windowAlive: true });
  }
  await page.context().tracing.stop({ path: path.join(out, 'trace.zip') });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2));
  console.log(JSON.stringify({ ok: true, out, checks }));
}
main().catch(async error => { console.error(error); await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); console.error(await page?.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: String(error), checks }, null, 2)); await page?.context().tracing.stop({ path: path.join(out, 'failure.zip') }).catch(() => {}); process.exitCode = 1; }).finally(async () => { await app?.close(); });
