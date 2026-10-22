import type { WorkbenchRequest, WorkbenchData } from '../../../../../packages/retail-domain/src/workbench-contract';
export async function workbenchRequest(input: WorkbenchRequest): Promise<WorkbenchData> {
  const reply = await window.electronAPI.retailRequest(input);
  if (!reply.ok) throw Error(reply.error);
  if (reply.kind !== 'workbench') throw Error('经营工作台返回类型不符');
  return reply.data;
}
export const workbenchDate = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false });
