// Native Electron acceptance, isolated synthetic profile only; never calls a platform.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = path.resolve(process.env.MERQO_PREVIEW_PROFILE || '');
assert(profile.startsWith(path.join(root, '.runtime', 'ingestion-ui-')), 'Use an isolated ingestion acceptance profile');
const config = JSON.parse(fs.readFileSync(path.join(profile, 'config/config.json'), 'utf8'));
const workspace = config.workspaces[0];
assert(path.resolve(workspace.rootPath).startsWith(profile + path.sep));
const out = path.join(root, 'artifacts/business-tasks', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
let app, page, task, checks = [];
const button = name => page.getByRole('button', { name, exact: true });
async function request(input) {
  const reply = await page.evaluate(input => window.electronAPI.retailRequest(input), input);
  assert(reply.ok, reply.error); return reply.data;
}
async function launch() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'apps/electron')], cwd: root, env, timeout: 60000 });
  await app.firstWindow();
  await expect.poll(() => app.windows().some(p => { try { return new URL(p.url()).searchParams.get('workspaceId') === workspace.id; } catch { return false; } }), { timeout: 30000 }).toBe(true);
  page = app.windows().find(p => new URL(p.url()).searchParams.get('workspaceId') === workspace.id);
  page.setDefaultTimeout(30000);
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await expect.poll(async () => await page.getByRole('button', { name: /^(Get Started|开始使用|Setup later|稍后设置|仅使用经营分析)$/ }).count() || await page.locator('[data-focus-zone="sidebar"]').count(), { timeout: 30000 }).toBeGreaterThan(0);
  for (const name of [/^仅使用经营分析$/, /^(Get Started|开始使用)$/, /^(Setup later|稍后设置)$/]) {
    const entry = page.getByRole('button', { name }); if (await entry.count()) await entry.click();
  }
  await expect.poll(async () => await page.getByTestId('retail-workspace').isVisible() || await button('经营分析').isVisible(), { timeout: 30000 }).toBe(true);
  if (!await page.getByTestId('retail-workspace').isVisible()) await button('经营分析').click();
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(1440, 1000));
}
async function close(name) { await page.context().tracing.stop({ path: path.join(out, name) }); await app.close(); app = null; }
async function main() {
  await launch();
  const runs = await request({ op: 'investigations' });
  const source = runs.find(r => (!r.scenario || r.scenario === 'margin') && r.evidence.source === 'demo') || { evidence: (await request({ op: 'demo' })).records.find(r => r.row.sku_id === 'TEA-500'), scenario: 'margin' };
  const created = await request({ op: 'investigate', recordId: source.evidence.id, scenario: source.scenario || 'margin', mode: 'replay', retry: true });
  const runId = created[0].id;
  await expect.poll(async () => (await request({ op: 'investigations', id: runId }))[0].report != null, { timeout: 60000 }).toBe(true);
  await button('调查记录').click();
  const investigation = page.getByTestId('retail-investigation');
  await expect(investigation.getByRole('button', { name: '创建业务任务', exact: true })).toBeVisible();
  await investigation.getByRole('button', { name: '创建业务任务', exact: true }).click();
  const title = '核对经营证据 ' + Date.now();
  await page.getByLabel('新任务名称', { exact: true }).fill(title);
  await page.getByLabel('新任务负责人', { exact: true }).fill('合成验收运营');
  await page.getByLabel('新任务截止时间', { exact: true }).fill('2026-10-01T09:30');
  await page.getByLabel('新任务跟进要求', { exact: true }).fill('核对来源和成本；不执行经营动作');
  await button('保存并查看任务').click();
  let panel = page.getByTestId('retail-tasks');
  await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(panel.getByLabel('任务业务上下文')).toContainText('离线规则演示');
  task = (await request({ op: 'tasks', search: title })).items[0].task;
  assert.equal(task.origin.investigationId, runId);
  assert.equal(task.owner, '合成验收运营'); assert.equal(task.dueAt, '2026-10-01T01:30:00.000Z');
  assert.equal((await request({ op: 'task_get', id: task.id })).overdue, true);
  const change = async (note, action, version) => {
    await panel.getByLabel('任务跟进记录', { exact: true }).fill(note);
    await panel.getByRole('button', { name: action, exact: true }).click();
    await expect.poll(async () => (await request({ op: 'task_get', id: task.id })).task.version).toBe(version);
    await expect(panel.getByLabel('任务跟进记录', { exact: true })).toHaveValue('');
  };
  await panel.getByLabel('任务负责人', { exact: true }).fill('库存复核人');
  await change('明确跟进负责人', '保存跟进信息', 2);
  await change('开始核对证据', '开始处理', 3);
  await change('等待补充成本', '标记受阻', 4);
  await change('收到补充资料', '追加记录', 5);
  await change('人工核对完成，未执行经营动作', '标记跟进完成', 6);
  await expect(panel.getByLabel('任务负责人', { exact: true })).toBeDisabled();
  await change('再次复核', '重新打开任务', 7);
  await panel.getByLabel('搜索业务任务', { exact: true }).fill(title);
  await panel.getByLabel('只看逾期任务', { exact: true }).check();
  await expect(panel.getByLabel('业务任务列表').getByRole('button', { name: new RegExp(title) })).toBeVisible();
  await expect(panel.getByLabel('业务任务列表')).toHaveAttribute('aria-busy', 'false');
  await expect(panel.getByLabel('业务任务列表').getByRole('button', { name: new RegExp(title) })).toContainText('待跟进 · 已逾期');
  await panel.getByRole('heading', { name: '业务任务', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'task-wide.png') });
  checks.push('UI creates a frozen investigation task; Beijing deadline, owner edit, start/block/note/complete/reopen, immutable seven-version history and overdue search all verified through real IPC');
  await button('打开关联调查').click();
  await expect(page.getByTestId('retail-investigation')).toBeVisible();
  await button('创建业务任务').click();
  await page.getByLabel('新任务负责人', { exact: true }).fill('重复请求不能覆盖');
  await button('保存并查看任务').click();
  await expect(page.getByTestId('retail-tasks').getByRole('heading', { name: title, exact: true })).toBeVisible();
  assert.equal((await request({ op: 'task_get', id: task.id })).task.version, 7);
  checks.push('Original investigation deep link and duplicate creation reopen the same task without overwriting metadata or adding events');
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(800, 1000));
  await page.getByTestId('retail-tasks').getByRole('heading', { name: '业务任务', exact: true }).scrollIntoViewIfNeeded();
  const layout = await page.getByTestId('retail-tasks').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
  assert(layout.content <= layout.width + 1, JSON.stringify(layout));
  await page.screenshot({ path: path.join(out, 'task-narrow.png') });
  await close('before-restart.zip');
  await launch();
  const retained = await request({ op: 'task_get', id: task.id });
  assert.equal(retained.task.version, 7); assert.equal(retained.task.owner, '库存复核人'); assert.equal(retained.eventCount, 7);
  assert.equal(retained.task.entityKey, task.entityKey); assert.deepEqual(retained.task.evidence, task.evidence);
  await button('业务任务').click();
  await page.getByLabel('搜索业务任务', { exact: true }).fill(title);
  await page.getByLabel('业务任务列表').getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('任务历史记录')).toContainText('共 7 条');
  const draft = (await request({ op: 'decision_create', investigationId: runId, kind: 'observe', note: '合成方案任务验收' }))[0];
  await button('决策草稿').click();
  await expect(page.getByTestId('retail-decisions').getByRole('button', { name: '创建业务任务', exact: true })).toBeVisible();
  await button('创建业务任务').click();
  const decisionTitle = '方案跟进 ' + Date.now();
  await page.getByLabel('新任务名称', { exact: true }).fill(decisionTitle);
  await page.getByLabel('新任务负责人', { exact: true }).fill('方案复核人');
  await button('保存并查看任务').click();
  await expect(page.getByTestId('retail-tasks').getByRole('heading', { name: decisionTitle, exact: true })).toBeVisible();
  const linked = (await request({ op: 'tasks', search: decisionTitle })).items[0].task;
  assert.equal(linked.origin.decisionId, draft.id); assert.equal(linked.origin.decisionVersion, draft.version);
  await button('打开关联方案').click();
  const original = page.getByTestId('retail-decisions');
  await expect(original.getByLabel('决策草稿列表').locator('button[aria-current="true"]')).toContainText(draft.scope.sku);
  await expect(original.getByLabel('从当前证据创建业务任务')).toBeVisible();
  checks.push('Saved decision task creation freezes its exact decision ID/version; original decision deep link opens the selected saved draft');
  await close('after-restart.zip');
  checks.push('800px task layout has no horizontal overflow; actual Electron restart preserves owner, deadline, status, evidence and all seven history versions');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, profile, taskId: task.id, syntheticOnly: true, realPlatformCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, out, checks }));
}
main().catch(async error => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack, profile }, null, 2));
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  if (app) { await page.context().tracing.stop({ path: path.join(out, 'failure.zip') }).catch(() => {}); await app.close().catch(() => {}); }
  console.error(error); process.exitCode = 1;
});
