import {PageHeader} from './PageHeader';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import type { CheckConfigInput, ChecksView } from '../../../../../packages/retail-domain/src/check-types';
const statuses = { running: '运行中', succeeded: '检查完成', failed: '失败', interrupted: '中断' };
const triggers = { manual: '手动', scheduled: '定时', catchup: '补跑' };
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export function ChecksPanel({ onAnomalies }: { onAnomalies: () => void }) {
  const [view, setView] = useState<ChecksView | null>(null);
  const [draft, setDraft] = useState<CheckConfigInput>({ enabled: false, intervalMinutes: 60, source: 'demo' });
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const pending = useRef(false), initialized = useRef(false), alive = useRef(true);
  const call = useCallback(async (request: RetailRequest) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const reply = await window.electronAPI.retailRequest(request);
      if (!reply.ok) throw new Error(reply.error);
      if (reply.kind !== 'checks') throw new Error('巡检返回类型不符');
      if (!alive.current) return;
      setView(reply.data);
      if (!initialized.current || request.op === 'check_configure') { setDraft(reply.data.config); initialized.current = true; }
      if (reply.data.lastAction) setNotice(`本次新运行 ${reply.data.lastAction.created} 个时段，复用 ${reply.data.lastAction.reused} 条已有记录。`);
      else if (request.op !== 'checks') setNotice(request.op === 'check_configure' ? '配置已保存；历史记录保留，新配置从当前时段生效。' : '已完成本次请求，请查看运行记录。');
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '巡检请求失败'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => { alive.current = true; void call({ op: 'checks' }); const timer = setInterval(() => void call({ op: 'checks' }), 15000); return () => { alive.current = false; clearInterval(timer); }; }, [call]);
  const selected = view?.runs.find(r => r.id === selectedId) ?? view?.runs[0];
  return <section data-testid="retail-checks">
    <PageHeader title="经营巡检" actions={<><button disabled={busy} onClick={() => void call({ op: 'checks' })}>刷新巡检记录</button></>}>定时检查毛利、缺货与广告异常，使用本机已导入快照。</PageHeader>
    <p className="retail-muted">应用运行时按分钟触发调度；关闭、休眠期间不保证检查。补跑读取补跑当时的快照，不还原历史实时状态，不调用模型、不自动审批或执行业务。</p>
    {error && <div className="retail-alert error" role="alert">{error}</div>}{notice && <div className="retail-alert" role="status">{notice}</div>}
    {!view ? <p>正在读取巡检配置与记录…</p> : <>
      <div className="retail-panel retail-check-config"><h3>检查配置</h3><div className="retail-scope">
        <label>自动检查<select aria-label="巡检启用状态" value={draft.enabled ? 'on' : 'off'} onChange={e => setDraft(d => ({ ...d, enabled: e.target.value === 'on' }))}><option value="off">暂停定时检查</option><option value="on">启用定时检查</option></select></label>
        <label>检查间隔<select aria-label="巡检间隔" value={draft.intervalMinutes} onChange={e => setDraft(d => ({ ...d, intervalMinutes: Number(e.target.value) as CheckConfigInput['intervalMinutes'] }))}><option value={15}>每 15 分钟</option><option value={60}>每小时</option><option value={1440}>每 24 小时（北京时间 08:00 起）</option></select></label>
        <label>检查来源<select aria-label="巡检数据来源" value={draft.source} onChange={e => setDraft(d => ({ ...d, source: e.target.value as CheckConfigInput['source'] }))}><option value="demo">演示数据</option><option value="csv">CSV 导入数据</option></select></label>
        <button className="retail-primary" disabled={busy} onClick={() => void call({ op: 'check_configure', expectedRevision: view.config.revision, config: { enabled: draft.enabled, intervalMinutes: draft.intervalMinutes, source: draft.source } })}>保存巡检配置</button>
      </div><p className="retail-muted">当前配置 v{view.config.revision} · {view.config.enabled ? '已启用' : '已暂停'} · 首次在下个分钟触发检查当前时段，之后每个 UTC 对齐时段只检查一次。界面时间按本机时区显示。</p></div>
      <div className="retail-inline-actions"><button disabled={busy} onClick={() => void call({ op: 'check_run' })}>检查当前时段</button><button disabled={busy || !view.pendingSlots.length} onClick={() => void call({ op: 'check_catchup' })}>补跑缺失时段（{view.pendingSlots.length}）</button><button onClick={onAnomalies}>查看当前异常</button></div>
      <p className="retail-muted">一次最多补跑 6 个时段，最多回看当前配置最近 24 个时段；更早 {view.olderSlotsExcluded} 个时段不在补跑窗口内。暂停后仍可手动检查；保存不同配置会开启新的时段去重范围。</p>
      <div className="retail-table-wrap retail-panel"><table aria-label="巡检运行列表"><thead><tr><th>目标时段</th><th>触发 / 版本</th><th>状态</th><th>检查 / 异常</th><th>新增 / 重复</th><th>操作</th></tr></thead><tbody>{view.runs.map(r => <tr key={r.id}><td>{date(r.slot)}</td><td>{triggers[r.trigger]} / v{r.config.revision}</td><td>{statuses[r.status]} · 第 {r.attempt} 次</td><td>{r.result ? `${r.result.checked} / ${r.result.anomalies}` : '—'}</td><td>{r.result ? `${r.result.newFindings} / ${r.result.repeatedFindings}` : '—'}</td><td><button aria-pressed={selected?.id === r.id} onClick={() => setSelectedId(r.id)}>查看记录</button></td></tr>)}</tbody></table>{!view.runs.length && <p>尚无巡检记录。可先手动检查当前时段。</p>}</div>
      {selected && <article className="retail-panel retail-check-detail" aria-label="巡检运行详情"><h3>{statuses[selected.status]} · {date(selected.slot)}</h3><p>开始：{date(selected.startedAt)}；结束：{date(selected.finishedAt)}；来源：{selected.config.source === 'demo' ? '演示' : 'CSV'}。</p>
        {selected.error && <p role="alert">{selected.error}</p>}
        {(['failed', 'interrupted'].includes(selected.status) && selected.attempt < 3 && selected.config.revision === view.config.revision) && <button disabled={busy} onClick={() => void call({ op: 'check_retry', id: selected.id })}>重试该巡检</button>}
        {selected.result && <><p>实际读取时间：{date(selected.result.observedAt)}。毛利 {selected.result.byScenario.margin} 条，库存 {selected.result.byScenario.inventory} 条，广告 {selected.result.byScenario.ads} 条。</p>{selected.result.warnings.map(w => <p key={w} className="retail-alert">{w}</p>)}<p>本次异常 {selected.result.anomalies} 条，其中首次发现 {selected.result.newFindings} 条、历史重复 {selected.result.repeatedFindings} 条。首次发现按规则版本与快照身份去重。</p><div className="retail-table-wrap"><table aria-label="巡检冻结异常"><thead><tr><th>场景 / 商品</th><th>店铺 / 渠道</th><th>经营日期</th><th>状态</th></tr></thead><tbody>{selected.result.findings.map(f => <tr key={f.key}><td>{{ margin: '毛利', inventory: '缺货', ads: '广告' }[f.scenario]} / {f.record.row.sku_id}</td><td>{f.record.row.shop_id} / {f.record.row.channel}</td><td>{f.record.row.date}</td><td>{f.record.status === 'needs_evidence' ? '待补证' : '异常'}</td></tr>)}</tbody></table></div>{selected.result.truncated && <p>仅展示前 200 条，合计覆盖本轮全部数据。</p>}<details><summary>冻结异常与证据引用</summary><pre>{JSON.stringify(selected.result.findings, null, 2)}</pre></details></>}
        {selected.history?.length > 0 && <details><summary>先前尝试记录</summary>{selected.history.map(h => <p key={h.attempt}>第 {h.attempt} 次 · {date(h.startedAt)} · {h.status} · {h.error}</p>)}</details>}
      </article>}
    </>}
  </section>;
}
