import { requestRetailWorker } from './retail-worker';
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
  const investigationTasks = new Map<string, AbortController>();
  ipcMain.handle('retail:request', async (event, input: unknown): Promise<RetailReply> => {
    try {
      // Only top-level contents belonging to a registered application window.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('经营数据接口不允许子页面访问');
      const workspaceId = getWindowManager()?.getWorkspaceForWindow(event.sender.id);
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null;
      if (!workspace || workspace.remoteServer) throw new Error('请选择本机 Workspace；远程经营数据暂不支持');
      const request = RetailRequestSchema.parse(input);
      const readOnly = ['checks', 'snapshot', 'signals', 'investigations', 'preview', 'signals_preview', 'investigation_export', 'decisions', 'decision_history', 'approvals', 'executions', 'compensations', 'execution_batches', 'reviews', 'review_preview'].includes(request.op);
      if ((readers.get(event.sender.id) ?? 0) >= 4) throw new Error('并发读取过多，请稍后重试');
      if (!readOnly && active.has(event.sender.id)) throw new Error('上一个经营数据请求尚未完成，请稍后重试');
      if (readOnly) readers.set(event.sender.id, (readers.get(event.sender.id) ?? 0) + 1);
      else active.add(event.sender.id);
      const workerRequest = (payload: unknown) => requestRetailWorker(workspace, workspaceId!, payload, request.op);
      try {
        const reply = await workerRequest(request);
        if (request.op === 'investigation_pause' && reply.ok) investigationTasks.get(`${workspaceId}:${request.id}`)?.abort('operator_pause');
        if ((request.op === 'investigate' || request.op === 'review_followup' || request.op === 'investigation_resume') && reply.ok && reply.kind === 'investigations' && reply.created) {
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
      } finally { if (readOnly) { const remaining = (readers.get(event.sender.id) ?? 1) - 1; if (remaining) readers.set(event.sender.id, remaining); else readers.delete(event.sender.id); } else active.delete(event.sender.id); }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '经营数据请求失败' }; }
  });
}
