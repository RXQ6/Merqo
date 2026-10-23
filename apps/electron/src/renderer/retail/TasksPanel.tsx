import { useCallback, useEffect, useState } from 'react';
import type { BusinessTask, TaskDetail, TaskPage } from '../../../../../packages/retail-domain/src/business-task-contract';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import { PageHeader } from './PageHeader';
import { taskDueInput, taskDueISO } from './TaskComposer';
import { draftStateLabels } from './DecisionValues';
import { TaskWorkbenchTools } from './TaskWorkbenchTools';
const states = { open: '待跟进', doing: '处理中', blocked: '受阻', done: '跟进完成', cancelled: '已取消' };
const reviews: Record<string, string> = { passed: '复核通过', needs_evidence: '待补证', failed: '复核未通过', rejected: '复核未通过' };
const date = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function TasksPanel({ initialId, onInvestigation, onDecision, onApproval, onExecution, onCase }: { initialId: string | null; onInvestigation: (id: string) => void; onDecision: (id: string) => void; onApproval: (id: string) => void; onExecution: (id: string) => void; onCase:(id:string)=>void }) {
  const [page, setPage] = useState<TaskPage | null>(null), [selectedId, setSelectedId] = useState(initialId), [detail, setDetail] = useState<TaskDetail | null>(null);
  const [status, setStatus] = useState<'all' | BusinessTask['status']>('all'), [overdue, setOverdue] = useState(false), [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const [note, setNote] = useState(''), [title, setTitle] = useState(''), [owner, setOwner] = useState(''), [due, setDue] = useState(''), [priority, setPriority] = useState<'normal' | 'high'>('normal');
  useEffect(() => {
    let alive = true; setLoading(true);
    const timer = setTimeout(() => { void window.electronAPI.retailRequest({ op: 'tasks', status, overdueOnly: overdue, search, offset, limit: 30 }).then(reply => {
      if (!alive) return;
      if (!reply.ok || reply.kind !== 'tasks') throw Error(!reply.ok ? reply.error : '任务列表返回类型不符');
      setPage(reply.data);
    }).catch(cause => { if (alive) setError(String(cause.message ?? cause)); }).finally(() => { if (alive) setLoading(false); }); }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [status, overdue, search, offset, revision]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true; setDetail(previous => previous?.task.id === selectedId ? previous : null);
    void window.electronAPI.retailRequest({ op: 'task_get', id: selectedId }).then(reply => {
      if (!alive) return;
      if (!reply.ok || reply.kind !== 'task') throw Error(!reply.ok ? reply.error : '任务详情返回类型不符');
      setDetail(reply.data);
    }).catch(cause => { if (alive) setError(String(cause.message ?? cause)); });
    return () => { alive = false; };
  }, [selectedId, revision]);
  useEffect(() => { if (!detail) return; const t = detail.task; setTitle(t.title); setOwner(t.owner); setDue(taskDueInput(t.dueAt)); setPriority(t.priority); setNote(''); }, [detail?.task.id, detail?.task.version]);
  const mutate = useCallback(async (input: RetailRequest) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const reply = await window.electronAPI.retailRequest(input);
      if (!reply.ok || reply.kind !== 'task') throw Error(!reply.ok ? reply.error : '任务修改返回类型不符');
      setDetail(reply.data);
      setNotice('跟进记录已保存；原始证据与审批记录保留。'); setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '任务保存失败'); }
    finally { setBusy(false); }
  }, []);
  const t = detail?.task, ended = !!t && ['done', 'cancelled'].includes(t.status);
  function transition(next: BusinessTask['status']) { if (t) void mutate({ op: 'task_transition', id: t.id, expectedVersion: t.version, status: next, note }); }
  function save() { if (!t) return; try { void mutate({ op: 'task_edit', id: t.id, expectedVersion: t.version, title, owner, dueAt: taskDueISO(due), priority, note }); } catch { setError('请填写有效截止时间'); } }
  return <section data-testid="retail-tasks">
    <PageHeader title="业务任务" actions={<button disabled={busy} onClick={() => { setError(''); setRevision(v => v + 1); }}>刷新任务</button>}>让调查、方案和后续处理对应到同一份业务证据。截止时间按北京时间显示。</PageHeader>
    {error && <p className="retail-alert error" role="alert">{error}</p>}{notice && <p className="retail-alert success" role="status">{notice}</p>}
    <div className="retail-task-counts" aria-label="任务范围计数">{page && <>{Object.entries(states).map(([key, label]) => <span key={key}>{label}<strong>{page.counts[key as keyof typeof states]}</strong></span>)}<span>已逾期<strong>{page.counts.overdue}</strong></span></>}</div>
    <div className="retail-scope"><label>搜索任务<input aria-label="搜索业务任务" placeholder="名称、负责人、店铺或 SKU" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }}/></label><label>任务状态<select aria-label="业务任务状态筛选" value={status} onChange={e => { setStatus(e.target.value as typeof status); setOffset(0); }}><option value="all">全部状态</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="retail-checkbox"><input type="checkbox" aria-label="只看逾期任务" checked={overdue} onChange={e => { setOverdue(e.target.checked); setOffset(0); }}/>只看逾期</label><p className="retail-muted">计数覆盖当前工作空间全部任务，不受搜索和分页影响。逾期在读取时计算，暂不自动催办。</p></div>
    <div className="retail-investigation-layout"><aside className="retail-investigation-list" aria-label="业务任务列表" aria-busy={loading}>
      {!page?.items.length && <p>{loading ? '正在读取任务…' : '当前没有匹配任务。可从调查报告或已保存的决策草稿创建。'}</p>}
      {page?.items.map(item => <button key={item.task.id} aria-current={selectedId === item.task.id ? 'true' : undefined} onClick={() => { setError(''); setNotice(''); setSelectedId(item.task.id); }}><strong>{item.task.title}</strong><span>{states[item.task.status]}{item.overdue ? ' · 已逾期' : ''}{item.task.priority === 'high' ? ' · 优先' : ''}</span><small>{item.task.owner} · {item.task.scope.shop} / {item.task.scope.sku}</small><small>{date(item.task.dueAt)}</small></button>)}
      <div className="retail-inline-actions"><button disabled={loading || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 30))}>上一页任务</button><button disabled={loading || !page || offset + 30 >= page.total} onClick={() => setOffset(v => v + 30)}>下一页任务</button><small>{page ? `${page.total ? offset + 1 : 0}–${offset + page.items.length} / ${page.total}` : '—'}</small></div>
    </aside><article className="retail-investigation-body">
      {!t || !detail ? <p>{selectedId ? '正在读取任务详情…' : '选择一条任务，查看原调查、方案和跟进记录。'}</p> : <>
        <h2>{t.title}</h2><p>{states[t.status]} · v{t.version} · {t.purpose === 'simulation_action' ? '模拟方案处理' : '分析跟进'}{detail.overdue ? ' · 已逾期' : ''}</p>
        <p>{t.description || '未填写额外跟进要求。'}</p>
        <section aria-label="任务业务上下文"><h3>关联业务与原始证据</h3><p>{t.scope.shop} / {t.scope.channel} / {t.scope.sku} / {t.scope.spec ?? '规格未声明'}；业务日期 {t.scope.date}</p><p>来源：{t.scope.source === 'demo' ? '合成演示' : 'CSV 声明'} · {t.scope.sourceId ?? '独立来源未声明'}{t.scope.warehouse ? `；仓库 ${t.scope.warehouse}` : ''}{t.scope.campaign ? `；广告活动 ${t.scope.campaign}` : ''}</p><p>{t.evidence.summary}</p><p className="retail-muted">这是创建时冻结的上下文，不代表当前库存、实时经营状态或真实授权。负责人为本机声明的跟进人。</p>
          <div className="retail-inline-actions"><button onClick={() => onInvestigation(t.origin.investigationId)}>打开关联调查</button>{t.origin.decisionId && <button onClick={() => onDecision(t.origin.decisionId!)}>打开关联方案</button>}{detail.link.approvalId && <button onClick={() => onApproval(detail.link.approvalId!)}>打开关联审批</button>}{detail.link.executionId && detail.link.approvalId && <button onClick={() => onExecution(detail.link.approvalId!)}>查看关联执行</button>}</div>
          {detail.link.warning && <p className="retail-alert" role="status">{detail.link.warning}</p>}
          <p className="retail-muted">调查方式：{t.evidence.mode === 'replay' ? '离线规则演示' : '模型调查'}；复核结果：{reviews[t.evidence.reviewer] ?? t.evidence.reviewer}。</p>
          <p>当前方案状态：{detail.link.decisionState ? draftStateLabels[detail.link.decisionState as keyof typeof draftStateLabels] ?? detail.link.decisionState : '未关联方案'}；本任务绑定的模拟回执：{detail.link.receiptId ?? '暂无成功回执'}。</p>
        </section>
        {!!t.caseReferences?.length&&<section aria-label="任务冻结案例"><h3>创建时引用的案例</h3>{t.caseReferences.map(r=><article className="experience-record" key={r.item.id}><strong>{r.item.title} · 任务 v{r.item.taskVersion}</strong><p>{r.item.lesson}</p><p>{r.item.declaredOutcome}</p><p>{r.item.limitation}</p></article>)}</section>}
        <section aria-label="任务跟进处理"><h3>跟进与处理</h3><div className="retail-sync-form retail-task-form">
          <label>任务名称<input aria-label="任务名称" disabled={busy || ended} value={title} maxLength={120} onChange={e => setTitle(e.target.value)}/></label><label>负责人<input aria-label="任务负责人" disabled={busy || ended} value={owner} maxLength={80} onChange={e => setOwner(e.target.value)}/></label>
          <label>截止时间（北京时间）<input aria-label="任务截止时间" disabled={busy || ended} type="datetime-local" value={due} onChange={e => setDue(e.target.value)}/></label><label>优先级<select aria-label="任务优先级" disabled={busy || ended} value={priority} onChange={e => setPriority(e.target.value as typeof priority)}><option value="normal">普通</option><option value="high">优先处理</option></select></label>
          <label>本次跟进记录／变更原因<textarea aria-label="任务跟进记录" rows={3} value={note} maxLength={2000} onChange={e => setNote(e.target.value)}/></label>
          <div className="retail-inline-actions"><button disabled={busy || ended || !note.trim() || !title.trim() || !owner.trim() || !due} onClick={save}>保存跟进信息</button><button disabled={busy || !note.trim()} onClick={() => void mutate({ op: 'task_note', id: t.id, expectedVersion: t.version, note })}>追加记录</button></div>
          <div className="retail-inline-actions">{ended ? <button disabled={busy || !note.trim()} onClick={() => transition('open')}>重新打开任务</button> : <>{(['open', 'doing', 'blocked', 'done', 'cancelled'] as const).filter(s => s !== t.status).map(s => <button key={s} disabled={busy || !note.trim() || (s === 'done' && t.purpose === 'simulation_action' && (detail.link.stale || !detail.link.receiptId))} onClick={() => transition(s)}>{s === 'doing' ? '开始处理' : s === 'blocked' ? '标记受阻' : s === 'done' ? '标记跟进完成' : s === 'cancelled' ? '取消任务' : '转回待跟进'}</button>)}</>}</div>
          <p>{t.purpose === 'simulation_action' ? '完成前必须取得当前绑定版本的成功模拟执行回执。审批和执行请打开原记录处理。' : '跟进完成只表示人工分析跟进结束，不代表经营动作已执行、问题已解决或效果已达成。'}</p>
        </div></section>
        <section aria-label="任务历史记录"><h3>跟进记录与版本</h3><p className="retail-muted">共 {detail.eventCount} 条，展示最近 {detail.events.length} 条；旧记录保留。</p>{detail.events.map(event => <details key={event.version}><summary>v{event.version} · {date(event.at)} · {states[event.to]}</summary><p>{event.note}</p><p>负责人：{event.snapshot.owner}；截止：{date(event.snapshot.dueAt)}；本机操作记录。</p></details>)}</section>
        <div ref={element=>{element?.toggleAttribute('inert',busy);}}><TaskWorkbenchTools key={t.id+':'+t.version} task={t} onCase={onCase}/></div>
        <details><summary>冻结证据索引</summary><p>调查 {t.origin.investigationId}；方案版本 {t.origin.decisionVersion ?? '未关联'}；规则 {t.evidence.ruleVersion}</p><p>证据摘要 {t.evidence.evidenceHash}</p><p>报告摘要 {t.evidence.reportHash}</p><p>实体范围摘要 {t.entityKey}</p></details>
      </>}
    </article></div>
  </section>;
}
