import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { RetailReply } from '../../../../packages/retail-domain/src/operations';

/** Scope and role come from trusted main-process callers, never renderer fields. */
export async function requestRetailWorker(workspace: {rootPath:string;name:string}, workspaceId: string, payload: unknown, operation: string): Promise<RetailReply> {
  const root = process.env.CRAFT_APP_ROOT || process.cwd();
  const worker = join(root, 'scripts/retailpilot-data-worker.ts');
  if (!existsSync(worker)) throw new Error('经营数据工作进程缺失，请重新安装或重新构建当前版本');
  return await new Promise<RetailReply>((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.CRAFT_BUN || 'bun', [worker, join(workspace.rootPath, 'retail', 'operations.sqlite'), workspace.name, workspaceId, operation === 'review_finalize' ? 'local-simulation-reviewer' : operation === 'approval_resolve' || operation === 'compensation_resolve' ? 'local-simulation-approver' : operation === 'simulation_execute' || operation === 'execution_reconcile' || operation === 'compensation_execute' || operation === 'compensation_reconcile' || operation === 'batch_run' || operation === 'batch_retry_item' || operation === 'batch_recover' ? 'local-simulation-executor' : 'local-analyst'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorText = '', settled = false;
    const timer = setTimeout(() => { settled = true; child.kill(); reject(new Error('经营数据请求超时，结果待确认；请刷新对应记录核对结果，不要连续重试')); }, 30000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 32_000_000) { child.kill(); } });
    child.stderr.on('data', (chunk: string) => { if (errorText.length < 2000) errorText += chunk; });
    child.on('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on('close', () => {
      clearTimeout(timer); if (settled) return; settled = true;
      try { const reply = JSON.parse(output.trim()) as RetailReply; if (typeof reply.ok !== 'boolean') throw new Error('Invalid worker reply'); resolve(reply); }
      catch { reject(new Error(errorText || '经营数据进程返回无效结果')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });

}
