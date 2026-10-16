import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { loadReadonlyScope, loadReadonlyRunScope, scopedToolNames, callReadonlyTool } from '../packages/retail-domain/src/readonly-tools';

const options: Record<string, string> = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]; const value = process.argv[index + 1];
  if (!flag || !['--workspace', '--scenario', '--record', '--run'].includes(flag) || !value || options[flag]) throw new Error('用法：bun scripts/merqo-retail-mcp.ts --workspace <本机Workspace绝对路径> --scenario margin|inventory|ads --record <记录ID>');
  options[flag] = value;
}
const runId = options['--run'] ? z.string().uuid().parse(options['--run']) : null;
if (runId && (options['--scenario'] || options['--record'])) throw new Error('run 与 scenario/record 不能同时指定');
const workspace = z.string().min(1).parse(options['--workspace']);
if (!isAbsolute(workspace)) throw new Error('必须提供绝对 Workspace 路径');
const scope = runId ? loadReadonlyRunScope(resolve(workspace), runId) : loadReadonlyScope(resolve(workspace), z.enum(['margin', 'inventory', 'ads']).parse(options['--scenario']), z.string().min(1).max(64).parse(options['--record']));
const scenario = scope.scenario;
const skill = readFileSync(new URL(`../packages/retail-domain/skills/${scenario}/SKILL.md`, import.meta.url), 'utf8');
const server = new McpServer({ name: 'merqo-retail-readonly', version: '1.0.0' });
for (const name of scopedToolNames(scope)) {
  server.registerTool(name, { description: `Read-only ${scenario} evidence for the operator-selected frozen record. No arguments or business writes.`, inputSchema: z.strictObject({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async () => ({ content: [{ type: 'text', text: JSON.stringify(callReadonlyTool(scope, name)) }] }));
}
const uri = `merqo://skills/${scenario}`;
server.registerResource(`merqo-${scenario}-skill`, uri, { mimeType: 'text/markdown', description: 'Versioned investigation Skill; no credential or filesystem URI access.' }, async () => ({ contents: [{ uri, mimeType: 'text/markdown', text: skill }] }));
await server.connect(new StdioServerTransport());
