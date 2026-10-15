import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { RetailRequestSchema } from '../../../../packages/retail-domain/src/operations';
import type { RetailReply } from '../../../../packages/retail-domain/src/operations';
import type { WindowManager } from './window-manager';

export function registerRetailIpc(getWindowManager: () => WindowManager | null): void {
  const active = new Set<number>();
  ipcMain.handle('retail:request', async (event, input: unknown): Promise<RetailReply> => {
    try {
      // Only top-level contents belonging to a registered application window.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('经营数据接口不允许子页面访问');
      const workspaceId = getWindowManager()?.getWorkspaceForWindow(event.sender.id);
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null;
      if (!workspace || workspace.remoteServer) throw new Error('请选择本机 Workspace；远程经营数据暂不支持');
      const request = RetailRequestSchema.parse(input);
      if (active.has(event.sender.id)) throw new Error('上一个经营数据请求尚未完成，请稍后重试');
      const root = process.env.CRAFT_APP_ROOT || process.cwd();
      const worker = join(root, 'scripts/retailpilot-data-worker.ts');
      if (!existsSync(worker)) throw new Error('经营数据工作进程缺失，请从源码项目启动当前版本');
      active.add(event.sender.id);
      try {
        return await new Promise<RetailReply>((resolve, reject) => {
          const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
          const child = spawn(process.env.CRAFT_BUN || 'bun', [worker, join(workspace.rootPath, 'retail', 'operations.sqlite'), workspace.name], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          let output = '', errorText = '', settled = false;
          const timer = setTimeout(() => { settled = true; child.kill(); reject(new Error('经营数据请求超时，请稍后重新读取导入记录确认结果')); }, 30000);
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
          child.stdin.end(JSON.stringify(request));
        });
      } finally { active.delete(event.sender.id); }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '经营数据请求失败' }; }
  });
}
