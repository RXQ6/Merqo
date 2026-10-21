// Run the actual packaged executable from outside the source tree, with no developer runtimes on PATH.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const exe = path.resolve(process.argv[2] || `artifacts/windows/${require('../packaging/windows-release.json').version}/win-unpacked/Merqo.exe`);
const out = path.join(root, 'artifacts/windows/verification',require('../packaging/windows-release.json').version); fs.mkdirSync(out, { recursive: true });
const restoreProfile = process.argv[3] === '--restore-profile' ? path.resolve(process.argv[4]) : null;
if (restoreProfile && !restoreProfile.startsWith(out + path.sep)) throw new Error('Restore profile must be an isolated verification directory');
const profile = restoreProfile || fs.mkdtempSync(path.join(out, 'profile-'));
let application; let page; let calls = 0; const checks = []; let runId; let receiptId;
let holdOnce = !restoreProfile, held = false, releaseHeld;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const system = body.messages[0].content; const context = JSON.parse(body.messages[1].content);
    assert.ok(!body.tools && !body.functions, 'isolated AgentBackend must expose no native tools');
    let value; calls++;
    if (system.includes('串行只读 Reviewer')) value = { verdict: 'passed', notes: ['本地安装包协议夹具，不是真实模型评测'] };
    else {
      const scenario = context.scenario || 'margin';
      if (holdOnce && scenario === 'margin' && context.observations.length === 1) { holdOnce = false; held = true; await new Promise(resolve => { releaseHeld = resolve; }); }
      const tools = ['retail_get_data_health', 'retail_get_sku_context', scenario === 'ads' ? 'retail_get_campaigns' : scenario === 'inventory' ? 'retail_get_inventory' : 'retail_get_promotions', 'retail_simulate_actions'];
      if (context.observations.length < 4) value = { tool: tools[context.observations.length] };
      else {
        const event = context.observations.find(t => t.tool === tools[2]);
        value = { report: { summary: '安装包协议验证报告', observations: [], hypotheses: [], unknowns: ['缺实时状态'], alternatives: ['可能存在口径差异'], options: [{ kind: 'observe', rationale: '核验' }, { kind: scenario === 'ads' ? 'reduce_budget' : scenario === 'inventory' ? 'replenish_draft' : 'reduce_coupon', rationale: '仅作条件测算' }] } };
      }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
});
async function launch() {
  const env = { ...process.env, CRAFT_CONFIG_DIR: path.join(profile, 'config'), RETAILPILOT_USER_DATA_DIR: path.join(profile, 'chromium'), RETAILPILOT_SMOKE: '1',
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, CRAFT_BUN: '' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CRAFT_APP_ROOT', 'CRAFT_DEV_RUNTIME', 'NODE_PATH', 'NODE_OPTIONS']) delete env[key];
  application = await electron.launch({ executablePath: exe, cwd: profile, env, timeout: 60000 });
  page = await application.firstWindow(); await page.context().tracing.start({ screenshots: true, snapshots: true });
  page.setDefaultTimeout(20000);
  const started = page.getByRole('button', { name: /^(Get Started|开始使用)$/ });
  const retailOnly = page.getByRole('button', { name: '仅使用经营分析', exact: true });
  await expect.poll(async () => (await started.count()) > 0 || (await retailOnly.count()) > 0 || (await page.locator('[data-focus-zone="sidebar"]').count()) > 0, { timeout: 30000 }).toBe(true);
  if (await retailOnly.count()) { await retailOnly.click(); checks.push('no-Git-Bash first run can enter retail analysis'); }
  if (await started.count()) {
    await started.click(); await page.getByRole('button', { name: /^(Setup later|稍后设置)$/ }).click();
  }
  await expect(page.locator('[data-focus-zone="sidebar"]')).toBeAttached();
  const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, app: app.getAppPath(), bun: process.env.CRAFT_BUN, name: app.getName() }));
  assert.equal(runtime.packaged, true); assert.equal(runtime.name, 'Merqo');
  assert.ok(runtime.app.startsWith(path.dirname(exe))); assert.ok(runtime.bun.startsWith(path.dirname(exe)));
  checks.push('actual packaged executable starts with bundled Bun and no developer PATH');
}
async function request(payload) {
  const reply = await page.evaluate(payload => window.electronAPI.retailRequest(payload), payload);
  assert.equal(reply.ok, true, reply.error); return reply;
}
async function close(phase) {
  await page.context().tracing.stop({ path: path.join(out, `${phase}-trace.zip`) }); await application.close(); application = null;
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await launch();
  if (restoreProfile) {
    assert.equal((await request({ op: 'snapshot', source: 'demo' })).data.records.length, 6);
    const executions = (await request({ op: 'executions' })).data;
    assert.ok(executions.some(e => e.receipt && e.status === 'succeeded'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'config/config.json'), 'utf8')).defaultLlmConnection, 'package-contract');
    await close('after-reinstall');
    fs.writeFileSync(path.join(out, 'packaged-restored.json'), JSON.stringify({ ok: true, profile, receiptId: executions.find(e => e.receipt).receipt.id, checks: ['installer reinstall preserves data, connection settings and execution receipt'] }, null, 2));
    server.close(); return;
  }
  await page.getByRole('button', { name: '经营分析', exact: true }).click();
  await expect(page.getByTestId('retail-workspace')).toBeVisible();
  assert.equal((await application.windows()).length, 1);
  await request({ op: 'demo' }); await request({ op: 'signals_demo' });
  const snap = await request({ op: 'snapshot' }); const signals = await request({ op: 'signals' });
  assert.equal(snap.data.records.length, 6); assert.equal(signals.data.records.length, 6);
  assert.equal(snap.data.records.find(r => r.row.sku_id === 'TEA-500').calculation.marginBps, 1429);
  checks.push('packaged data worker imports three scenarios and computes the expected margin');
  const configPath = path.join(profile, 'config/config.json'); const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.llmConnections = [{ slug: 'package-contract', name: '本地安装包协议夹具', providerType: 'pi_compat', authType: 'none', createdAt: Date.now(), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'pi/deepseek-v4-flash', piAuthProvider: 'deepseek', customEndpoint: { api: 'openai-completions' } }];
  config.defaultLlmConnection = 'package-contract'; fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const records = [snap.data.records.find(r => r.row.sku_id === 'TEA-500'), ...signals.data.records.filter(r => r.row.sku_id === 'TEA-500')];
  let adsRun;
  for (const record of records) {
    const scenario = record.kind || 'margin';
    const created = await request({ op: 'investigate', recordId: record.id, scenario, mode: 'model', retry: true }); const id = created.data[0].id;
    if (scenario === 'margin') {
      await expect.poll(() => held, { timeout: 30000 }).toBe(true);
      await page.getByRole('button', { name: '调查记录', exact: true }).click();
      await page.getByRole('button', { name: '暂停调查', exact: true }).click();
      await expect.poll(async () => (await request({ op: 'investigations', id })).data[0].state).toBe('paused');
      releaseHeld();
      await page.getByRole('button', { name: '高级工作台', exact: true }).click();
      await close('paused'); await launch();
      assert.equal((await request({ op: 'investigations', id })).data[0].state, 'paused');
      await page.getByRole('button', { name: '经营分析', exact: true }).click();
      await page.getByRole('button', { name: '调查记录', exact: true }).click();
      await page.getByRole('button', { name: /^继续调查（新增5分钟/ }).click();
      checks.push('UI pause survives actual process restart; explicit resume preserves frozen evidence and remaining call budget');
    }
    let completed;
    await expect.poll(async () => {
      completed = (await request({ op: 'investigations', id })).data[0]; return completed.state;
    }, { timeout: 90000, message: `packaged ${scenario} protocol: ${id}` }).toBe('completed');
    assert.equal(completed.report.reviewer.verdict, 'passed');
    assert.equal(completed.trace.filter(t => t.stage === 'investigate' && t.transport === 'mcp_stdio').length, 4);
    assert.ok(completed.trace.filter(t => t.stage === 'budget' && t.tool === 'model_request').length <= 14);
    if (scenario === 'ads') adsRun = completed;
    checks.push(`packaged ${scenario} API protocol, bundled MCP, four scoped tools and Skill work`);
  }
  assert.ok(calls >= 18 && calls <= 20); assert.ok(adsRun); runId = adsRun.id;
  const draft = (await request({ op: 'decision_create', investigationId: runId, kind: 'reduce_budget', note: '安装包协议验收，仅模拟' })).data[0];
  const pending = (await request({ op: 'decision_submit', id: draft.id, expectedVersion: 1 })).data.find(d => d.id === draft.id);
  const approval = pending.request;
  await request({ op: 'approval_resolve', requestId: approval.id, expectedVersion: 1, expectedActionHash: approval.actionHash, choice: 'approve', reason: '安装包本地模拟验收' });
  const job = (await request({ op: 'executions' })).data[0].job;
  const executed = (await request({ op: 'simulation_execute', id: job.id, expectedVersion: 1, expectedActionHash: job.actionHash })).data[0];
  assert.ok(executed.receipt); assert.equal(executed.reconciliation.matched, true); receiptId = executed.receipt.id;
  assert.equal((await request({ op: 'simulation_execute', id: job.id, expectedVersion: 1, expectedActionHash: job.actionHash })).data[0].receipt.id, receiptId);
  checks.push('packaged approval, isolated execution, reread and receipt idempotency');
  const sample = snap.data.records.find(r => r.row.sku_id === 'TEA-500').row;
  const fields = Object.keys(sample);
  const csvCell = value => '"' + String(value).replaceAll('"','""') + '"';
  const pageCsv = [fields.join(','), ...Array.from({length:120},(_,i)=>fields.map(field=>csvCell(field==='sku_id'?`PAGE-${String(i).padStart(3,'0')}`:sample[field])).join(','))].join('\n');
  await request({op:'import',csv:pageCsv,mapping:Object.fromEntries(fields.map(field=>[field,field]))});
  await page.getByRole('button',{name:'经营总览',exact:true}).click();
  await page.getByLabel('数据来源',{exact:true}).selectOption('csv');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(31);
  await expect(page.getByRole('table')).toContainText('PAGE-000');
  const metricText = await page.getByLabel('经营指标').innerText();
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('table')).toContainText('PAGE-030');
  assert.equal(await page.getByLabel('经营指标').innerText(),metricText);
  await page.getByLabel('搜索商品或 SKU',{exact:true}).fill('PAGE-119');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table')).toContainText('PAGE-119');
  assert.equal(await page.getByLabel('经营指标').innerText(),metricText);
  checks.push('actual UI uses bounded server pages; next-page and search preserve full-scope exact metric totals');
  await page.screenshot({ path: path.join(out, 'installed-analysis.png') });
  await page.getByRole('button', { name: '高级工作台', exact: true }).click();
  await expect(page.locator('[data-focus-zone="sidebar"]')).toBeVisible();
  checks.push('analysis and conversations round-trip in a single window');
  await close('initial'); await launch();
  assert.equal((await request({ op: 'snapshot', source: 'demo' })).data.records.length, 6);
  assert.equal((await request({ op: 'executions' })).data[0].receipt.id, receiptId);
  assert.equal((await request({ op: 'investigations', id: runId })).data[0].report.reviewer.verdict, 'passed');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).defaultLlmConnection, 'package-contract');
  checks.push('normal restart preserves demo data, model connection settings, investigation and execution receipt');
  await close('restart');
  fs.writeFileSync(path.join(out, 'packaged-smoke.json'), JSON.stringify({ ok: true, exe, profile, runId, receiptId, checks, calls, modelFixture: true, liveModelQuality: false, noDeveloperPath: true }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, calls })); server.close();
}
main().catch(async error => {
  releaseHeld?.();
  console.error(error); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  if (application) { await page.context().tracing.stop({ path: path.join(out, 'failure-trace.zip') }).catch(() => {}); await application.close().catch(() => {}); }
  fs.writeFileSync(path.join(out, 'packaged-smoke.json'), JSON.stringify({ ok: false, error: String(error), checks, calls, profile }, null, 2)); server.close(); process.exitCode = 1;
});
