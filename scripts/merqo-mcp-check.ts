import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store';
import { connectRetailMcp } from '../apps/electron/src/main/retail-mcp';
import { SignalStore } from '../packages/retail-domain/src/signal-store';
import { RetailStore } from '../packages/retail-domain/src/store';
import { DEMO_CSV } from '../packages/retail-domain/src/operations';
import { ADS_DEMO } from '../packages/retail-domain/src/signals';
const workspace = mkdtempSync(join(tmpdir(), 'merqo-mcp-')); mkdirSync(join(workspace, 'retail'));
const margin = new RetailStore(join(workspace, 'retail/operations.sqlite')); margin.import(DEMO_CSV, undefined, 'demo');
const signals = new SignalStore(join(workspace, 'retail/operations.sqlite.signals.sqlite')); signals.demo();
const investigations = new InvestigationStore(join(workspace, 'retail/operations.sqlite.investigations.sqlite'));
const checks: string[] = [];
try {
  for (const scenario of ['margin', 'inventory', 'ads'] as const) {
    const record = scenario === 'margin' ? margin.snapshot().records.find(r => r.row.sku_id === 'TEA-500')! : signals.snapshot().records.find(r => r.kind === scenario && r.row.sku_id === 'TEA-500')!;
    const run = scenario === 'margin' ? investigations.create(margin.snapshot().records.find(r=>r.id===record.id)!, 'replay').run : investigations.createSignal(signals.snapshot().records.find(r=>r.id===record.id)!, 'replay').run;
    const client = new Client({ name: 'merqo-protocol-check', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/merqo-retail-mcp.ts', '--workspace', workspace, '--scenario', scenario, '--record', record.id], cwd: resolve('.'), stderr: 'pipe' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 4); assert(tools.every(t => t.annotations?.readOnlyHint && !t.annotations?.destructiveHint));
      for (const tool of tools) { const reply = await client.callTool({ name: tool.name, arguments: {} }); assert(!reply.isError); assert(JSON.stringify(reply).includes(record.id)); }
      assert((await client.callTool({ name: tools[0]!.name, arguments: { workspace: 'other', sql: 'DELETE FROM signal_current' } })).isError);
      assert((await client.callTool({ name: 'execute_purchase', arguments: {} })).isError);
      const denied = scenario === 'ads' ? 'retail_get_inventory' : 'retail_get_campaigns';
      assert((await client.callTool({ name: denied, arguments: {} })).isError);
      const resources = await client.listResources(); assert.equal(resources.resources.length, 1);
      const skillReply = await client.readResource({ uri: resources.resources[0]!.uri }); assert(JSON.stringify(skillReply).includes(`merqo-${scenario}`)); assert(JSON.stringify(skillReply).includes('version: 1.0.0'));
      const before = await client.callTool({ name: 'retail_simulate_actions', arguments: {} });
      if (scenario === 'ads') signals.import('ads', ADS_DEMO.replace(',180000,', ',220000,'), undefined, 'demo');
      const after = await client.callTool({ name: 'retail_simulate_actions', arguments: {} });
      const payload = (r: unknown) => { const parsed = z.object({ content: z.array(z.object({ text: z.string() })).min(1) }).parse(r); const d = JSON.parse(parsed.content[0]!.text) as Record<string, unknown>; delete d.retrievedAt; return d; };
      assert.deepEqual(payload(before), payload(after));
      checks.push(`${scenario}: real stdio tools, scope denial, Skill resource and frozen evidence passed`);
    } finally { await client.close(); }
    const desktop = await connectRetailMcp(run, workspace);
    try { const result = await desktop.tool('retail_get_data_health'); assert(JSON.stringify(result).includes('hash')); assert(desktop.skill.includes(`merqo-${scenario}`)); await assert.rejects(desktop.tool('execute_purchase')); checks.push(`${scenario}: desktop MCP adapter validates frozen run scope after correction`); } finally { await desktop.close(); }
    investigations.update(run.id,{error:'protocol test complete'});
  }
  mkdirSync('artifacts/m2', { recursive: true }); writeFileSync('artifacts/m2/mcp-check.json', JSON.stringify({ ok: true, checks }, null, 2));
  console.log(checks.join('\n'));
} finally { investigations.close(); signals.close(); margin.close(); rmSync(workspace, { recursive: true, force: true }); }
