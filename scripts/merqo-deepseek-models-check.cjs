// Isolated desktop + local HTTP model-list fixture; no paid inference or real credentials.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(root, '.runtime/deepseek-ui-'));
const out = path.join(root, 'artifacts/deepseek-models', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
let app, page, mode = 'ok', calls = 0;
const checks = [];
const server = http.createServer((req, res) => {
  assert.equal(req.url, '/models'); assert.equal(req.headers.authorization, 'Bearer synthetic-ui-key'); calls++;
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'fail') { res.statusCode = 429; res.end('{"error":"do-not-display-this-body"}'); return; }
  res.end(JSON.stringify({ data: [
    { id: 'deepseek-flash', name: 'DeepSeek Current Flash', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max'] } },
    { id: 'deepseek-v4-pro', name: 'DeepSeek Pro', input_modalities: ['text'] },
    ...(mode === 'new' ? [{ id: 'newly-published', name: 'New API Model' }] : []),
  ] }));
});
async function launch() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv[2];
  if (packaged) env.PATH = process.env.SystemRoot + '\\System32;' + process.env.SystemRoot;
  app = await electron.launch({ executablePath: packaged ? path.resolve(packaged) : path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [path.join(root, 'apps/electron')], cwd: packaged ? profile : root, env, timeout: 60000 });
  if (packaged) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await expect.poll(async () => await page.getByRole('button', { name: /^(Get Started|开始使用|Setup later|稍后设置|仅使用经营分析)$/ }).count() || await page.locator('[data-focus-zone="sidebar"]').count()).toBeGreaterThan(0);
  for (const name of [/^仅使用经营分析$/, /^(Get Started|开始使用)$/, /^(Setup later|稍后设置)$/]) {
    const b = page.getByRole('button', { name }); if (await b.count()) await b.click();
  }
  await expect(page.locator('[data-focus-zone="sidebar"]')).toBeAttached();
}
async function openSettings() {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('craft-agent-navigate', { detail: { route: 'settings/ai' } })));
  await expect(page.getByRole('table', { name: 'DeepSeek 可用模型' })).toBeVisible();
}
async function close(trace) { await page.context().tracing.stop({ path: path.join(out, trace) }); await app.close(); app = null; }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await launch(); await close('initial.zip');
  const configPath = path.join(profile, 'config/config.json'), config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.llmConnections = [{ slug: 'deepseek-ui', name: 'DeepSeek UI', providerType: 'pi', piAuthProvider: 'deepseek', authType: 'api_key', createdAt: Date.now(), baseUrl: `http://127.0.0.1:${server.address().port}`, models: ['pi/deepseek-v4-flash'], defaultModel: 'pi/deepseek-v4-flash', modelSelectionMode: 'userDefined3Tier' }];
  config.defaultLlmConnection = 'deepseek-ui'; fs.writeFileSync(configPath, JSON.stringify(config));
  const seed = spawnSync('bun', ['-e', "import {getCredentialManager} from './packages/shared/src/credentials/manager.ts'; await getCredentialManager().setLlmApiKey('deepseek-ui','synthetic-ui-key');"], { cwd: root, env: { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config') }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  await launch(); await openSettings();
  await expect(page.getByRole('table', { name: 'DeepSeek 可用模型' })).toContainText('DeepSeek Current Flash');
  await expect(page.getByText(/当前选择 deepseek-v4-flash 未被最新列表返回/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'DeepSeek 可用模型' })).toContainText('1,048,576 / 393,216');
  checks.push('startup fetches authenticated API list, capabilities and preserves the unreturned old selection');
  mode = 'fail'; await page.getByRole('button', { name: '刷新模型', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 429');
  await expect(page.getByRole('status').filter({ hasText: '缓存列表' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'DeepSeek 可用模型' })).toContainText('DeepSeek Current Flash');
  assert(!(await page.locator('body').innerText()).includes('do-not-display-this-body'));
  checks.push('failed refresh exposes safe HTTP error and retains cached models and last successful sync');
  mode = 'new'; await page.getByRole('button', { name: '刷新模型', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'New API Model' });
  await expect(row).toBeVisible(); await row.getByRole('button', { name: '设为默认', exact: true }).click();
  await expect(row.getByRole('button', { name: '当前模型', exact: true })).toBeDisabled();
  checks.push('manual refresh discovers a new ID absent from SDK and can select it as connection default');
  await page.screenshot({ path: path.join(out, 'models.png'), fullPage: true });
  await close('models.zip'); mode = 'fail'; await launch(); await openSettings();
  await expect(page.getByRole('row').filter({ hasText: 'New API Model' }).getByRole('button', { name: '当前模型', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: '缓存列表' })).toBeVisible();
  checks.push('actual restart while API fails preserves discovered model metadata and selected default');
  await close('restart.zip'); server.close();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, calls, fixture: true, liveInference: false }, null, 2));
  console.log(JSON.stringify({ ok: true, out, checks }));
}
main().catch(async error => { fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2)); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); if (app) await app.close().catch(() => {}); server.close(); console.error(error); process.exitCode = 1; });
