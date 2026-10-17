import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspaces } from '@craft-agent/shared/config';
import { SchedulerService } from '../../../../packages/shared/src/scheduler/scheduler-service';
import { requestRetailWorker } from './retail-worker';
import { mainLog } from './logger';

/** Reuses Craft's minute-aligned scheduler. No cron daemon or closed-app guarantee. */
export function createRetailCheckScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const workspace of getWorkspaces()) {
        if (workspace.remoteServer || !existsSync(join(workspace.rootPath, 'retail', 'operations.sqlite.checks.sqlite'))) continue;
        try {
          const reply = await requestRetailWorker(workspace, workspace.id, { op: 'check_tick' }, 'check_tick');
          if (!reply.ok) mainLog.warn('经营巡检调度失败', { workspaceId: workspace.id, error: reply.error });
        } catch (error) { mainLog.warn('经营巡检进程未完成，请查看巡检记录', { workspaceId: workspace.id, error: error instanceof Error ? error.message : 'unknown' }); }
      }
    } finally { busy = false; }
  };
  const scheduler = new SchedulerService(tick);
  return { start: () => scheduler.start(), stop: () => scheduler.stop(), tick };
}
