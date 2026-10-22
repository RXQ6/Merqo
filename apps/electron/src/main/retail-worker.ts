import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync,readFileSync } from 'node:fs';
import type { RetailReply } from '../../../../packages/retail-domain/src/operations';

// A backup freezes worker admission, drains existing workers, then releases queued requests.
const gates=new Map<string,{frozen:boolean;active:Set<Promise<unknown>>;waiters:Array<()=>void>}>();
function gate(id:string){let g=gates.get(id);if(!g){g={frozen:false,active:new Set(),waiters:[]};gates.set(id,g);}return g;}
export async function freezeRetailWorkers<T>(id:string,run:()=>Promise<T>):Promise<T>{const g=gate(id);if(g.frozen)throw Error('当前工作空间正在备份');g.frozen=true;try{await Promise.allSettled([...g.active]);return await run();}finally{g.frozen=false;g.waiters.splice(0).forEach(w=>w());}}
const blockedRestoredOperations=new Set(['wb_tick','wb_configure','wb_plan','approval_resolve','simulation_execute','execution_reconcile','compensation_resolve','compensation_execute','compensation_reconcile','batch_run','batch_retry_item','batch_recover','decision_submit','decision_revise','review_finalize','check_tick','check_configure','check_run','check_catchup','check_retry']);
export async function requestRetailWorker(workspace:{rootPath:string;name:string},workspaceId:string,payload:unknown,operation:string):Promise<RetailReply>{
 const g=gate(workspaceId);while(g.frozen)await new Promise<void>(resolve=>g.waiters.push(resolve));
 const marker=join(workspace.rootPath,'retail','restored-history.json');let owner=workspaceId;
 if(existsSync(marker)){const restored=JSON.parse(readFileSync(marker,'utf8'));if(!restored.ready)throw Error('此恢复工作空间未完成注册与凭据校验，请从原始备份重新恢复');if(blockedRestoredOperations.has(operation))throw Error('恢复工作空间保留历史证据，审批、执行与自动巡检已锁定；请在正常工作空间重新调查和审批');owner=restored.originalWorkspaceId;}
 const pending=runRetailWorker(workspace,owner,payload,operation);g.active.add(pending);try{return await pending;}finally{g.active.delete(pending);}
}
/** Scope and role come from trusted main-process callers, never renderer fields. */
async function runRetailWorker(workspace: {rootPath:string;name:string}, workspaceId: string, payload: unknown, operation: string): Promise<RetailReply> {
  const root = process.env.CRAFT_APP_ROOT || process.cwd();
  const worker = join(root, 'scripts/retailpilot-data-worker.ts');
  if (!existsSync(worker)) throw new Error('经营数据工作进程缺失，请重新安装或重新构建当前版本');
  return await new Promise<RetailReply>((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.CRAFT_BUN || 'bun', [worker, join(workspace.rootPath, 'retail', 'operations.sqlite'), workspace.name, workspaceId, operation === 'catalog_update' || operation === 'policy_update'?'local-simulation-admin':operation === 'review_finalize' ? 'local-simulation-reviewer' : operation === 'approval_resolve' || operation === 'compensation_resolve' ? 'local-simulation-approver' : operation === 'simulation_execute' || operation === 'execution_reconcile' || operation === 'compensation_execute' || operation === 'compensation_reconcile' || operation === 'batch_run' || operation === 'batch_retry_item' || operation === 'batch_recover' ? 'local-simulation-executor' : 'local-analyst'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorText = '', settled = false;
    const timeoutMs = operation === 'wb_tick' || operation === 'transactions_import' || operation === 'transactions_preview' || operation === 'import' || operation === 'signals_import' ? 120000 : 30000;
    const timer = setTimeout(() => { settled = true; child.kill(); reject(new Error('经营数据请求超时，结果待确认；请刷新对应记录核对结果，不要连续重试')); }, timeoutMs);
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
