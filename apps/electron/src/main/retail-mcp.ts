import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { z } from 'zod';
import type { AnyInvestigation, ReadonlyToolPort } from '../../../../packages/retail-domain/src/investigations';
const CONTENT = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string().max(500000) })).length(1), isError: z.boolean().optional() });
const ENVELOPE = z.object({ data: z.unknown(), caseContextHash:z.string(), evidenceId: z.string(), snapshotHash: z.string(), ruleVersion: z.string(), batchId: z.string(), scope: z.object({ scenario: z.string(), shop: z.string(), channel: z.string(), sku: z.string(), date: z.string(), warehouse: z.string().nullable(), campaign: z.string().nullable() }) });
/** Only this fixed child server receives one trusted workspace/run pair. No renderer-provided commands or registry tools. */
export async function connectRetailMcp(run: AnyInvestigation, workspace: string): Promise<{ tool: ReadonlyToolPort; skill: string; close: () => Promise<void> }> {
  const root = process.env.CRAFT_APP_ROOT || process.cwd();
  const client = new Client({ name: 'merqo-desktop-investigation', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.env.CRAFT_BUN || 'bun', args: [join(root, 'scripts/merqo-retail-mcp.ts'), '--workspace', workspace, '--run', run.id], cwd: root, stderr: 'pipe' });
  // Drain stderr to avoid a blocked child; never propagate raw server output into reports.
  transport.stderr?.on('data', () => {});
  const options = () => { const remaining = Date.parse(run.deadlineAt) - Date.now(); if (remaining <= 0) throw new Error('调查超过5分钟预算'); return { timeout: Math.min(15000, remaining) }; };
  const scenario = run.scenario ?? 'margin';
  const expected = ['retail_get_data_health', 'retail_get_sku_context', scenario === 'margin' ? 'retail_get_promotions' : scenario === 'inventory' ? 'retail_get_inventory' : 'retail_get_campaigns', 'retail_simulate_actions'];
  try {
    await client.connect(transport, options());
    const listed = await client.listTools({}, options());
    if (listed.tools.length !== 4 || listed.tools.some(t => !expected.includes(t.name) || t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint !== false)) throw new Error('经营MCP工具面不符合只读契约');
    const resource = await client.readResource({ uri: `merqo://skills/${scenario}` }, options());
    const skill = z.object({ contents: z.array(z.object({ text: z.string().min(1).max(40000) })).length(1) }).parse(resource).contents[0]!.text;
    return { skill, close: () => client.close(), tool: async name => {
      if (!expected.includes(name)) throw new Error('经营MCP拒绝范围外工具');
      const reply = CONTENT.parse(await client.callTool({ name, arguments: {} }, undefined, options()));
      if (reply.isError) throw new Error('经营MCP只读查询失败，证据已保留，可重新调查');
      const payload = ENVELOPE.parse(JSON.parse(reply.content[0]!.text));
      const e = run.evidence; const hash = 'hash' in e ? e.hash : e.snapshotHash;
      if (payload.evidenceId !== `${run.recordId}:${name}` || payload.snapshotHash !== hash || payload.ruleVersion !== e.ruleVersion || payload.batchId !== e.batchId || payload.scope.scenario !== scenario || payload.scope.shop !== e.row.shop_id || payload.scope.channel !== e.row.channel || payload.scope.sku !== e.row.sku_id || payload.scope.date !== e.row.date || payload.scope.warehouse !== ('warehouse_id' in e.row ? e.row.warehouse_id : null) || payload.scope.campaign !== ('campaign_id' in e.row ? e.row.campaign_id : null)) throw new Error('MCP返回证据与冻结范围不符，调查已停止');
      const expectedCases=run.caseContext??[];
      const context=z.object({historicalCases:z.unknown()}).safeParse(payload.data);
      if (payload.caseContextHash!==createHash('sha256').update(JSON.stringify(expectedCases)).digest('hex') || (name==='retail_get_sku_context' && (!context.success || JSON.stringify(context.data.historicalCases)!==JSON.stringify(expectedCases)))) throw new Error('MCP历史Case与冻结范围不符');
      return payload.data;
    } };
  } catch (error) { await client.close().catch(() => {}); if (error instanceof Error && /冻结范围|只读契约|预算/.test(error.message)) throw error; throw new Error('经营MCP连接失败，请检查本机Bun和服务文件后重新调查'); }
}
