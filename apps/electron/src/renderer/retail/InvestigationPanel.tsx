import { useCallback, useEffect, useRef, useState } from 'react';
import type { EvidenceRecord, RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import type { Investigation } from '../../../../../packages/retail-domain/src/investigations';

const states = { running: '调查中', completed: '分析完成', needs_evidence: '待补证 / 待复核', failed: '调查失败' };
const amount = (n: number | null) => n === null ? '待补证' : `¥${(n / 100).toFixed(2)}`;
export function InvestigationPanel({ target, onBack }: { target: EvidenceRecord | null; onBack: () => void }) {
  const [runs, setRuns] = useState<Investigation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false }; }, []);
  const call = useCallback(async (request: RetailRequest, select = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const reply = await window.electronAPI.retailRequest(request);
      if (!reply.ok) throw new Error(reply.error);
      if (reply.kind !== 'investigations') throw new Error('调查服务返回类型不符');
      if (alive.current) {
        setRuns(previous => [...new Map([...previous, ...reply.data].map(r => [r.id, r])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        if (select && reply.data[0]) setSelectedId(reply.data[0].id);
      }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '调查请求失败'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (target) void call({ op: 'investigate', recordId: target.id, mode: 'model' }, true);
    else void call({ op: 'investigations' });
  }, [target?.id, call]);
  const selected = runs.find(r => r.id === selectedId) ?? runs[0];
  const hasRunning = runs.some(r => r.state === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void call({ op: 'investigations' }), 1500);
    return () => clearInterval(timer);
  }, [hasRunning, call]);
  const record = selected?.evidence ?? target;
  const start = (mode: 'model' | 'replay') => { if (record) void call({ op: 'investigate', recordId: record.id, mode, retry: true }, true) };
  const report = selected?.report;
  const citation = (id: string) => <a key={id} href={`#investigation-evidence-${selected?.trace.findIndex(t => t.evidenceId === id)}`} title={id}>[{id.split(':').at(-1)}]</a>;
  return <section data-testid="retail-investigation" className="retail-investigation">
    <div className="retail-section-title"><div><h2>促销毛利调查</h2><p>只读调查 → 证据归纳 → 条件测算 → 复核。当前不提供审批或改价。</p></div><button onClick={onBack}>返回经营总览</button></div>
    {error && <div className="retail-alert error" role="alert">{error}<button disabled={busy} onClick={() => void call({ op: 'investigations' })}>重新读取调查</button></div>}
    <div className="retail-investigation-layout">
      <aside className="retail-investigation-list" aria-label="调查记录"><div className="retail-inline-actions"><strong>最近调查</strong><button disabled={busy} onClick={() => void call({ op: 'investigations' })}>刷新</button></div>
        {!runs.length && <p className="retail-muted">从毛利预警记录点击“开始调查”。需在设置中配置 API 模型连接。</p>}
        {runs.map(run => <button key={run.id} aria-current={run.id === selected?.id ? 'true' : undefined} onClick={() => setSelectedId(run.id)}><strong>{run.evidence.row.product_name}</strong><span>{run.evidence.row.sku_id} · {run.mode === 'replay' ? '离线演示' : '模型调查'}</span><small>{states[run.state]} · {new Date(run.createdAt).toLocaleString('zh-CN')}</small></button>)}
      </aside>
      <article className="retail-investigation-body">
        {record && <><h2>{record.row.product_name} · {record.row.sku_id}</h2><p className="retail-muted">{record.row.shop_id} / {record.row.channel} / {record.row.date} / {record.row.spec}</p>
          <div className="retail-inline-actions"><button disabled={busy || selected?.state === 'running'} className="retail-primary" onClick={() => start('model')}>重新进行模型调查</button><button disabled={busy || selected?.state === 'running'} onClick={() => start('replay')}>运行离线规则演示</button></div></>}
        {selected && <><p role="status" className="retail-investigation-status">{states[selected.state]} · {selected.mode === 'replay' ? '离线规则演示，未调用模型' : selected.model ?? (selected.state === 'running' ? '正在检查模型连接' : '未建立模型连接')}{selected.state === 'running' ? ' · 最长 5 分钟，最多 12 次决策与 1 次复核' : ''}</p>
          {selected.error && <div className="retail-alert error" role="alert">{selected.error}</div>}
          <p className="retail-muted">证据来自创建调查时的冻结快照。历史分析不代表当前实时状态；模型观点仍需人工核验。</p>
          {report && <><h3>调查摘要</h3><p>{report.summary}</p>
            <h3>观察与证据</h3><ul>{report.observations.map((o, i) => <li key={i}>{o.text} <span className="retail-citations">{o.evidenceIds.map(citation)}</span></li>)}</ul>
            <h3>原因假设（尚未证实）</h3>{report.hypotheses.length ? <ul>{report.hypotheses.map((o, i) => <li key={i}>{o.text} <span className="retail-citations">{o.evidenceIds.map(citation)}</span></li>)}</ul> : <p>暂无可支持的原因假设。</p>}
            <h3>替代解释</h3><ul>{report.alternatives.map((o, i) => <li key={i}>{o}</li>)}</ul>
            <h3>未知项 / 待补证</h3><ul>{report.unknowns.map((o, i) => <li key={i}>{o}</li>)}</ul>
            <h3>方案比较（代码测算）</h3><div className="retail-table-wrap"><table aria-label="调查方案比较"><thead><tr><th>方案</th><th>商家券 / 件</th><th>收入 / 件</th><th>毛利 / 件</th><th>毛利率</th><th>阈值检查</th></tr></thead><tbody>{report.scenarios.map(s => <tr key={s.kind}><td>{s.title}</td><td>{amount(s.couponMinor)}</td><td>{amount(s.revenueMinor)}</td><td>{amount(s.profitMinor)}</td><td>{s.marginBps === null ? '待补证' : `${(s.marginBps / 100).toFixed(2)}%`}</td><td>{s.passed ? '达到演示阈值' : '未通过 / 需补证'}</td></tr>)}</tbody></table></div>
            {report.scenarios.map(s => <details key={s.kind}><summary>{s.title}：假设与约束</summary><p>{s.rationale}</p><ul>{[...s.assumptions, ...s.constraints].map((v, i) => <li key={i}>{v}</li>)}</ul></details>)}
            <h3>{report.reviewer.mode === 'model' ? '只读 Reviewer 复核' : '离线规则复核'}</h3><p>{({ passed: '分析复核通过，不构成执行授权', needs_evidence: '需要补证', rejected: '复核驳回' })[report.reviewer.verdict]}</p><ul>{report.reviewer.notes.map((v, i) => <li key={i}>{v}</li>)}</ul>
          </>}
          <h3>调查过程与原始证据</h3>{!selected.trace.length && <p className="retail-muted">{selected.state === 'running' ? '正在连接模型，工具返回后会显示在这里。' : '尚未产生工具证据。'}</p>}
          {selected.trace.map((event, i) => <details key={i} id={`investigation-evidence-${i}`}><summary>{event.stage === 'review' ? '复核' : '只读查询'} · {event.tool} · {new Date(event.at).toLocaleTimeString('zh-CN')}</summary><p className="retail-muted">证据 ID：{event.evidenceId}</p><pre>{JSON.stringify(event.data, null, 2)}</pre></details>)}
          <details><summary>冻结快照与来源摘要</summary><pre>{JSON.stringify(selected.evidence, null, 2)}</pre></details>
        </>}
      </article>
    </div>
  </section>;
}
