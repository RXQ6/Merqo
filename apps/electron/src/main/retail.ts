import { requestRetailWorker } from './retail-worker';
import {handleRetailBackup} from './retail-backup';
import {handleRetailSync} from './retail-sync';
import { ipcMain } from 'electron';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { RetailRequestSchema } from '../../../../packages/retail-domain/src/operations';
import type { RetailReply } from '../../../../packages/retail-domain/src/operations';
import { executeRetailInvestigation } from './retail-investigation';
import type { WindowManager } from './window-manager';

export function registerRetailIpc(getWindowManager: () => WindowManager | null): void {
  ipcMain.handle('retail:window', (event, action: unknown, ...extra: unknown[]) => {
    try {
      if (event.senderFrame !== event.sender.mainFrame || extra.length) throw new Error('经营窗口请求无效');
      if (action !== 'open' && action !== 'agent') throw new Error('未知窗口操作');
      const manager = getWindowManager();
      const workspaceId = manager?.getWorkspaceForWindow(event.sender.id);
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null;
      if (!manager || !workspaceId || !workspace || workspace.remoteServer) throw new Error('请选择本机 Workspace；远程经营窗口暂不支持');
      // Switch only the trusted calling renderer; navigation never creates a window.
      event.sender.send('retail:surface', action);
      return {ok:true};
    } catch (error) { return {ok:false,error:error instanceof Error ? error.message : '窗口打开失败'}; }
  });
  const active = new Set<number>();
  const readers = new Map<number, number>();
  const readWaiters=new Map<number,Array<()=>void>>();
  async function acquireRead(id:number){
    if((readers.get(id)??0)<4){readers.set(id,(readers.get(id)??0)+1);return;}
    const queue=readWaiters.get(id)??[];if(queue.length>=12)throw Error('读取请求过多，请稍后重试');readWaiters.set(id,queue);
    await new Promise<void>((resolve,reject)=>{const grant=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{const index=queue.indexOf(grant);if(index>=0)queue.splice(index,1);reject(Error('读取排队超时，请刷新对应面板'));},15000);queue.push(grant);});
  }
  function releaseRead(id:number){const queue=readWaiters.get(id),next=queue?.shift();if(next){next();return;}readWaiters.delete(id);const count=(readers.get(id)??1)-1;if(count)readers.set(id,count);else readers.delete(id);}
  const investigationTasks = new Map<string, AbortController>();
  ipcMain.handle('retail:request', async (event, input: unknown): Promise<RetailReply> => {
    try {
      // Only top-level contents belonging to a registered application window.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('经营数据接口不允许子页面访问');
      const workspaceId = getWindowManager()?.getWorkspaceForWindow(event.sender.id);
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null;
      if (!workspace || workspace.remoteServer) throw new Error('请选择本机 Workspace；远程经营数据暂不支持');
      const request = RetailRequestSchema.parse(input);
      const readOnly = ['tasks','task_get','ad_refund_reports','exchange_reports','warehouse_view','warehouse_preview','procurement_view','procurement_preview','contribution_comparisons','sync_cleanup_view','inspections_view','inspections_preview','contribution_reports','ingest_issues','ingest_inspect','ingest_view','sync_job','sync_view','investigation_supplement_preview','catalog','transactions_page','transactions_preview','policy','checks', 'snapshot', 'signals', 'signals_page', 'investigations', 'preview', 'signals_preview', 'investigation_export', 'decisions', 'decision_history', 'approvals', 'executions', 'compensations', 'execution_batches', 'reviews', 'review_preview'].includes(request.op);
      if (!readOnly && active.has(event.sender.id)) throw new Error('上一个经营数据请求尚未完成，请稍后重试');
      if (readOnly) await acquireRead(event.sender.id);
      else active.add(event.sender.id);
      const workerRequest = (payload: unknown) => requestRetailWorker(workspace, workspaceId!, payload, request.op);
      try {
        if(request.op.startsWith('backup_'))return await handleRetailBackup(workspace,workspaceId!,event.sender,request,id=>{getWindowManager()?.createWindow({workspaceId:id,retail:true});});
        if(request.op.startsWith('sync_')||request.op.startsWith('ingest_'))return await handleRetailSync(workspace,workspaceId!,request);
        const reply = await workerRequest(request);
        if (request.op === 'investigation_pause' && reply.ok) investigationTasks.get(`${workspaceId}:${request.id}`)?.abort('operator_pause');
        if ((request.op === 'investigation_supplement' || request.op === 'investigate' || request.op === 'review_followup' || request.op === 'investigation_resume') && reply.ok && reply.kind === 'investigations' && reply.created) {
          const run = reply.data[0];
          if (run) {
            const key = `${workspaceId}:${run.id}`; const controller = new AbortController(); investigationTasks.set(key, controller);
            void executeRetailInvestigation(run, workspace.rootPath, async patch => {
              const saved = await workerRequest({ op: 'investigation_update', id: run.id, expectedEpoch: run.epoch ?? 0, ...patch });
              if (!saved.ok) throw new Error(saved.error);
            }, controller.signal).catch(() => { /* Paused/stale epochs cannot publish late results. */ }).finally(() => { if (investigationTasks.get(key) === controller) investigationTasks.delete(key); });
          }
        }
        return reply;
      } finally { if (readOnly) releaseRead(event.sender.id); else active.delete(event.sender.id); }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '经营数据请求失败' }; }
  });
}
