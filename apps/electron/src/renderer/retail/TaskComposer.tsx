import { useState } from 'react';
import type { TaskCreate } from '../../../../../packages/retail-domain/src/business-task-contract';

export const taskDueInput = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
export const taskDueISO = (value: string) => new Date(value + '+08:00').toISOString();
export function TaskComposer({ origin, title, simulationAllowed = false, onCreated }: { origin: TaskCreate['origin']; title: string; simulationAllowed?: boolean; onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [name, setName] = useState(title), [owner, setOwner] = useState(''), [due, setDue] = useState(() => taskDueInput(new Date(Date.now() + 86400000).toISOString()));
  const [purpose, setPurpose] = useState<TaskCreate['purpose']>(simulationAllowed ? 'simulation_action' : 'analysis_followup');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal'), [description, setDescription] = useState('');
  async function create() {
    setBusy(true); setError('');
    try {
      const reply = await window.electronAPI.retailRequest({ op: 'task_create', origin, title: name, owner, dueAt: taskDueISO(due), purpose, priority, description });
      if (!reply.ok || reply.kind !== 'task') throw Error(!reply.ok ? reply.error : '任务返回类型不符');
      onCreated(reply.data.task.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '任务创建失败'); }
    finally { setBusy(false); }
  }
  return <section className="retail-task-compose" aria-label="从当前证据创建业务任务">
    <button disabled={busy} onClick={() => setOpen(value => !value)}>{open ? '收起任务表单' : '创建业务任务'}</button>
    {open && <div className="retail-sync-form">
      <h3>把当前分析交给后续跟进</h3>
      <p>任务绑定当前已保存的调查或方案。负责人是本机填写的跟进人，不代表已验证账号，也不会向他人发送通知。</p>
      <label>任务名称<input aria-label="新任务名称" value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label>
      <label>负责人<input aria-label="新任务负责人" value={owner} maxLength={80} placeholder="例如：门店运营" onChange={e => setOwner(e.target.value)}/></label>
      <label>截止时间（北京时间）<input aria-label="新任务截止时间" type="datetime-local" value={due} onChange={e => setDue(e.target.value)}/></label>
      <label>优先级<select aria-label="新任务优先级" value={priority} onChange={e => setPriority(e.target.value as typeof priority)}><option value="normal">普通</option><option value="high">优先处理</option></select></label>
      <label>跟进类型<select aria-label="新任务类型" value={purpose} onChange={e => setPurpose(e.target.value as typeof purpose)}><option value="analysis_followup">分析跟进</option>{simulationAllowed && <option value="simulation_action">模拟方案处理</option>}</select></label>
      <p>{purpose === 'simulation_action' ? '完成前必须走原有模拟审批和执行流程，并取得本版本的成功回执。' : '完成表示人工跟进已结束，不代表经营动作执行成功或效果达成。'}</p>
      <label>跟进要求<textarea aria-label="新任务跟进要求" value={description} maxLength={2000} rows={3} onChange={e => setDescription(e.target.value)}/></label>
      {error && <p role="alert">{error}</p>}
      <div className="retail-inline-actions"><button className="retail-primary" disabled={busy || !name.trim() || !owner.trim() || !due} onClick={() => void create()}>保存并查看任务</button><span className="retail-muted">同一来源版本、同一类型重复创建会打开已有任务。</span></div>
    </div>}
  </section>;
}
