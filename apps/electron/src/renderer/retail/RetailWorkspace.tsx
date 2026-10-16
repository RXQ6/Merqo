import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Boxes, CircleAlert, FileSpreadsheet, LayoutDashboard, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { DEMO_CSV, exportCsv, FIELDS, FIELD_LABELS } from '../../../../../packages/retail-domain/src/operations';
import type { EvidenceRecord, Preview, RetailRequest, RetailReply, Snapshot } from '../../../../../packages/retail-domain/src/operations';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { useRegisterDismissibleLayer } from '@/context/DismissibleLayerContext';
import { SignalsPanel } from './SignalsPanel';
import type { SignalSnapshot, SignalRecord } from '../../../../../packages/retail-domain/src/signals';
import { ApprovalsPanel } from './ApprovalsPanel';
import { DecisionsPanel } from './DecisionsPanel';
import type { AnyInvestigation } from '../../../../../packages/retail-domain/src/investigations';
import { InvestigationPanel } from './InvestigationPanel';
import './retail.css';

const money = (value: number | bigint | null): string => {
  if (value === null) return '待补证';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '金额超出精度范围';
  const minor = BigInt(value), absolute = minor < 0n ? -minor : minor;
  return '¥' + (minor < 0n ? '-' : '') + (absolute / 100n).toLocaleString('zh-CN') + '.' + (absolute % 100n).toString().padStart(2, '0');
};
const percent = (value: number | null) => value === null ? '—' : (value / 100).toFixed(2) + '%';
const labels = { normal: '正常', low_margin: '毛利预警', needs_evidence: '待补证' };
function download(name: string, content: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function RetailWorkspace({ onOpenAgent }: { onOpenAgent: () => void }) {
  const [approvalRequestId,setApprovalRequestId] = useState<string | null>(null);
  const [decisionTarget,setDecisionTarget] = useState<AnyInvestigation | null>(null);
  const [investigationTarget, setInvestigationTarget] = useState<EvidenceRecord | SignalRecord | null>(null);
  const [signals, setSignals] = useState<SignalSnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<'overview' | 'anomalies' | 'data' | 'investigations' | 'signals' | 'decisions' | 'approvals'>('overview');
  const [source, setSource] = useState<'demo' | 'csv'>('demo');
  const [shop, setShop] = useState(''); const [channel, setChannel] = useState(''); const [date, setDate] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<EvidenceRecord | null>(null);
  useRegisterDismissibleLayer(useMemo(() => selected ? {
    id: 'retail-evidence', type: 'modal' as const, priority: 100,
    close: () => setSelected(null),
  } : null, [selected]));
  const detailRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false); const pending = useRef(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null); const [mapping, setMapping] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useCallback(async (input: RetailRequest): Promise<RetailReply | undefined> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const reply = await window.electronAPI.retailRequest(input);
      if (!reply.ok) throw new Error(reply.error);
      if (reply.kind === 'signals') { setSignals(reply.data); if (reply.notice) setNotice(reply.notice); if (input.op === 'signals_import' || input.op === 'signals_demo') { setSource(input.op === 'signals_import' ? 'csv' : 'demo'); setShop(''); setChannel(''); setDate(''); } }
      if (reply.kind === 'snapshot') { setSnapshot(reply.data); if (reply.signals) setSignals(reply.signals); if (reply.notice) setNotice(reply.notice); }
      return reply;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请求失败，请重试'); return; }
    finally { pending.current = false; setBusy(false); }
  }, []);
  useEffect(() => { void request({ op: 'snapshot' }); }, [request]);
  useEffect(() => { setOffset(0); }, [query, source, shop, channel, date, status, page]);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement;
    detailRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [selected]);
  const sourceRows = useMemo(() => snapshot?.records.filter(record => record.source === source) ?? [], [snapshot, source]);
  const scoped = useMemo(() => sourceRows.filter(record => (!shop || record.row.shop_id === shop) && (!channel || record.row.channel === channel) && (!date || record.row.date === date)), [sourceRows, shop, channel, date]);
  const filtered = useMemo(() => scoped.filter(record => (page !== 'anomalies' || record.status !== 'normal') && (status === 'all' || record.status === status) && (!query || `${record.row.sku_id} ${record.row.product_name} ${record.row.spec}`.toLowerCase().includes(query.toLowerCase()))), [scoped, page, status, query]);
  const signalScope = { source, shop, channel, date, query };
  const scopeRows = [...sourceRows.map(r => r.row), ...(signals?.records.filter(r => r.source === source).map(r => r.row) ?? [])];
  const signalCount = signals?.records.filter(r => r.source === source && r.status !== 'normal' && (!shop || r.row.shop_id === shop) && (!channel || r.row.channel === channel) && (!date || r.row.date === date)).length ?? 0;
  const known = scoped.filter(record => record.status !== 'needs_evidence');
  const revenue = known.reduce((sum, record) => sum + BigInt(record.calculation.totalRevenueMinor ?? 0), 0n);
  const profit = known.reduce((sum, record) => sum + BigInt(record.calculation.totalProfitMinor ?? 0), 0n);
  const warning = scoped.filter(record => record.status === 'low_margin').length;
  const missing = scoped.filter(record => record.status === 'needs_evidence').length;
  const latest = (page === 'signals' ? signals?.batches : snapshot?.batches)?.filter(batch => batch.source === source)[0];
  const loadingFirst = busy && !snapshot;
  const loadDemo = async () => { const reply = await request({ op: 'demo' }); if (reply?.ok) { setSource('demo'); setShop(''); setChannel(''); setDate(''); } };
  const openCsv = async (file: File) => {
    setError(''); setNotice(''); setPreview(null);
    if (file.size > 2_000_000) { setError('文件超过 2 MB，请缩小范围'); return; }
    try {
      const text = await file.text(); setCsv(text); setFileName(file.name);
      const result = await request({ op: 'preview', csv: text });
      if (result?.ok && result.kind === 'preview') { setMapping(result.data.mapping); setPreview(result.data); setPage('data'); }
    } catch { setError('无法读取文件，请使用 UTF-8 编码的 CSV'); }
  };
  const validateMapping = async () => { const result = await request({ op: 'preview', csv, mapping }); if (result?.ok && result.kind === 'preview') setPreview(result.data); };
  const importRows = async () => {
    const result = await request({ op: 'import', csv, mapping });
    if (result?.ok) { setSource('csv'); setShop(''); setChannel(''); setDate(''); setPreview(null); setCsv(''); }
  };
  const updateMapping = (key: string, value: string) => { setMapping(current => ({ ...current, [key]: value })); setPreview(current => current ? { ...current, valid: [] } : null); };
  return <div className="retail-app" data-testid="retail-workspace">
    <PanelHeader title="经营分析" actions={<button className="retail-link" onClick={onOpenAgent}><ArrowLeft size={14}/>返回会话</button>}/>
    <nav className="retail-tabs" aria-label="经营导航">
      <button aria-current={page === 'overview' ? 'page' : undefined} onClick={() => { setPage('overview'); setStatus('all'); }}><LayoutDashboard size={14}/>经营总览</button>
      <button aria-current={page === 'anomalies' ? 'page' : undefined} onClick={() => { setPage('anomalies'); setStatus('all'); }}><CircleAlert size={14}/>异常中心<span className="retail-tab-count">{warning + missing + signalCount}</span></button>
      <button aria-current={page === 'data' ? 'page' : undefined} onClick={() => setPage('data')}><FileSpreadsheet size={14}/>数据与导入</button>
      <button aria-current={page === 'signals' ? 'page' : undefined} onClick={() => { setQuery(''); setPage('signals'); }}>库存与广告</button>
      <button aria-current={page === 'investigations' ? 'page' : undefined} onClick={() => { setInvestigationTarget(null); setPage('investigations'); }}>调查记录</button>
      <button aria-current={page === 'decisions' ? 'page' : undefined} onClick={() => { setDecisionTarget(null); setPage('decisions'); }}>决策草稿</button>
      <button aria-current={page === 'approvals' ? 'page' : undefined} onClick={() => { setApprovalRequestId(null); setPage('approvals'); }}>审批中心</button>
    </nav>
    <main className="retail-main">
      {page === 'approvals' ? <ApprovalsPanel initialRequestId={approvalRequestId} onBack={() => { setDecisionTarget(null); setPage('decisions'); }}/> : page === 'decisions' ? <DecisionsPanel target={decisionTarget} onBack={() => setPage('overview')} onApproval={id => { setApprovalRequestId(id); setPage('approvals'); }}/> : page === 'investigations' ? <InvestigationPanel target={investigationTarget} onBack={() => setPage('overview')} onDraft={run => { setDecisionTarget(run); setPage('decisions'); }}/> : <>
      <header className="retail-header"><div><h1>{page === 'overview' ? '商品毛利分析' : page === 'anomalies' ? '经营异常' : page === 'signals' ? '库存与广告' : '经营数据'}</h1><p>{page === 'data' ? '导入前预览并检查口径，错误行隔离，历史快照保留。' : page === 'signals' ? '按相邻等长窗口核对销量、库存覆盖与广告回报。' : page === 'anomalies' ? '按店铺、渠道与经营日期核对三类异常及证据。' : '按店铺、渠道与经营日期核对商品收入、成本和优惠。'}</p></div>
        <div className="retail-header-actions"><button disabled={busy} onClick={() => void request({ op: 'snapshot' })} aria-label="刷新经营数据"><RefreshCw size={17}/></button><button className="retail-primary" disabled={busy} onClick={() => { if (page === 'signals') document.querySelector<HTMLInputElement>('input[aria-label="选择库存或广告 CSV"]')?.click(); else { setPage('data'); fileInput.current?.click(); } }}><FileSpreadsheet size={16}/>{page === 'signals' ? '导入场景 CSV' : '导入毛利 CSV'}</button></div>
      </header>
      <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="选择经营 CSV 文件" className="retail-file-input" onChange={event => { const file = event.target.files?.[0]; if (file) void openCsv(file); event.target.value = ''; }}/>
      {error && <div className="retail-alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误"><X size={16}/></button></div>}
      {notice && <div className="retail-alert success" role="status">{notice}</div>}
      <div className="retail-scope"><label>数据来源<select aria-label="数据来源" value={source} onChange={event => { setSource(event.target.value as 'demo' | 'csv'); setShop(''); setChannel(''); setDate(''); }}><option value="demo">演示数据</option><option value="csv">CSV 导入数据</option></select></label>
        <label>店铺<select aria-label="店铺" value={shop} onChange={event => setShop(event.target.value)}><option value="">全部店铺</option>{[...new Set(scopeRows.map(row => row.shop_id))].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>渠道<select aria-label="渠道" value={channel} onChange={event => setChannel(event.target.value)}><option value="">全部渠道</option>{[...new Set(scopeRows.map(row => row.channel))].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>经营日期<select aria-label="经营日期" value={date} onChange={event => setDate(event.target.value)}><option value="">全部日期</option>{[...new Set(scopeRows.map(row => row.date))].sort().reverse().map(value => <option key={value}>{value}</option>)}</select></label>
        <span className="retail-scope-note">{source === 'demo' ? '合成快照，非实时经营数据' : '静态导入快照，非实时同步'}<small>{latest ? `最近导入 ${new Date(latest.importedAt).toLocaleString('zh-CN')}` : '尚未载入数据'}</small></span>
      </div>
      {loadingFirst ? <div className="retail-empty" role="status">正在读取本机经营数据…</div> : page === 'signals' ? <SignalsPanel onInvestigate={record => { setInvestigationTarget(record); setPage('investigations'); }} snapshot={signals} request={request} busy={busy} scope={signalScope}/> : page === 'data' ? <>
        <section className="retail-import-intro"><div><h2>先确认数据口径，再开始分析</h2><p>一行代表一个店铺、渠道、SKU 在某个经营日期的快照。金额单位为“分”，净成交件数已扣除退款。商品毛利不包含广告、运费与平台佣金。</p><div className="retail-inline-actions"><button className="retail-primary" disabled={busy} onClick={() => fileInput.current?.click()}>选择 CSV 文件</button><button onClick={() => download('RetailPilot-经营快照模板.csv', '\uFEFF' + DEMO_CSV)}>下载带示例的模板</button><button disabled={busy} onClick={() => void loadDemo()}>载入演示数据</button></div></div><FileSpreadsheet size={56}/></section>
        {preview && <section className="retail-panel" aria-label="导入预览"><div className="retail-section-title"><div><h2>导入预览 · {fileName}</h2><p>总计 {preview.total} 行，有效 {preview.valid.length} 行，隔离 {preview.rejected.length} 行，其中重复 {preview.duplicateCount} 行。</p></div><button onClick={() => setPreview(null)} aria-label="关闭导入预览"><X size={18}/></button></div>
          <div className="retail-mappings">{FIELDS.map(key => <label key={key}>{FIELD_LABELS[key]}<select aria-label={`映射 ${FIELD_LABELS[key]}`} value={mapping[key] ?? ''} onChange={event => updateMapping(key, event.target.value)}><option value="">选择列</option>{preview.headers.map(header => <option key={header}>{header}</option>)}</select></label>)}</div>
          <div className="retail-table-wrap"><table><caption>CSV 原始内容预览（前 4 行）</caption><thead><tr>{preview.headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.sample.map((row, index) => <tr key={index}>{row.map((value, col) => <td key={col}>{value || '空值'}</td>)}</tr>)}</tbody></table></div>
          {!!preview.rejected.length && <details open><summary>错误行与隔离原因（显示前 30 条）</summary><ul className="retail-rejected">{preview.rejected.slice(0, 30).map(item => <li key={item.line}>第 {item.line} 条记录：{item.reason}</li>)}</ul></details>}
          <div className="retail-inline-actions"><button disabled={busy} onClick={() => void validateMapping()}>重新校验映射</button><button className="retail-primary" disabled={busy || !preview.valid.length} onClick={() => void importRows()}>导入 {preview.valid.length} 条有效数据</button></div>
        </section>}
        <section className="retail-panel"><div className="retail-section-title"><h2>导入记录与数据健康</h2><span>有效数据入库，错误行独立留档</span></div>{!snapshot?.batches.length ? <p className="retail-muted">还没有导入记录。可以先载入演示数据。</p> : <div className="retail-table-wrap"><table><thead><tr><th>来源</th><th>导入时间</th><th>有效</th><th>隔离</th><th>快照摘要</th><th>质量报告</th></tr></thead><tbody>{snapshot.batches.map(batch => <tr key={batch.id}><td>{batch.source === 'demo' ? '演示数据' : 'CSV 文件'}</td><td>{new Date(batch.importedAt).toLocaleString('zh-CN')}</td><td>{batch.accepted}</td><td>{batch.rejected}</td><td title={batch.hash}>{batch.hash.slice(0, 12)}</td><td><button className="retail-link" onClick={() => download(`导入质量报告-${batch.id}.json`, JSON.stringify(batch, null, 2), 'application/json')}>导出报告</button></td></tr>)}</tbody></table></div>}</section>
      </> : !sourceRows.length ? <section className="retail-empty"><Boxes size={46}/><h2>{source === 'demo' ? '从一组可核对的经营数据开始' : '还没有 CSV 经营数据'}</h2><p>查看优惠叠加如何影响毛利，区分真实预警与证据缺口。</p><div className="retail-inline-actions"><button className="retail-primary" disabled={busy} onClick={() => void loadDemo()}>载入演示数据</button><button onClick={() => { setPage('data'); fileInput.current?.click(); }}>导入自己的 CSV</button></div></section> : <>
        <div className="retail-metrics" aria-label="经营指标"><div><span>商家商品收入</span><strong>{money(revenue)}</strong><small>已具备完整证据的 {known.length} / {scoped.length} 条快照</small></div><div><span>商品毛利</span><strong>{money(profit)}</strong><small>商品收入减成本，不等同净利润</small></div><div><span>毛利预警</span><strong className="retail-danger">{warning}<em>条</em></strong><small>低于 {(snapshot?.thresholdBps ?? 2000) / 100}% 演示阈值</small></div><div><span>待补证</span><strong className="retail-amber">{missing}<em>条</em></strong><small>不计入收入与毛利合计</small></div></div>
        <section className="retail-panel"><div className="retail-section-title"><div><h2>{page === 'anomalies' ? '异常快照' : '商品经营快照'}</h2><p>先核对同规格、同期间数据，再判断经营动作。</p></div><button disabled={!filtered.length} onClick={() => download('RetailPilot-经营异常与证据.csv', exportCsv(filtered))}><ArrowDownToLine size={16}/>导出当前结果</button></div>
          <div className="retail-table-toolbar"><label className="retail-search"><Search size={16}/><input aria-label="搜索商品或 SKU" placeholder="搜索商品、规格或 SKU" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="异常状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="low_margin">毛利预警</option><option value="needs_evidence">待补证</option>{page !== 'anomalies' && <option value="normal">正常</option>}</select><span>{filtered.length} 条快照</span></div>
          <div className="retail-table-wrap"><table><thead><tr><th>商品与规格</th><th>店铺 / 日期</th><th>成交件数</th><th>商品收入 / 件</th><th>毛利率</th><th>可售 / 在途</th><th>状态</th><th>证据 / 调查</th></tr></thead><tbody>{filtered.slice(offset, offset + 30).map(record => <tr key={record.id}><td><strong>{record.row.product_name}</strong><small>{record.row.sku_id} · {record.row.spec}</small></td><td>{record.row.shop_id}<small>{record.row.date}</small></td><td>{record.row.sold_qty}</td><td>{money(record.calculation.revenueMinor)}</td><td className={record.status === 'low_margin' ? 'retail-danger' : ''}>{percent(record.calculation.marginBps)}</td><td>{record.calculation.available} / {record.row.inbound_qty}</td><td><span className={`retail-badge ${record.status}`}>{labels[record.status]}</span></td><td><button className="retail-link" onClick={() => setSelected(record)} aria-label={`查看 ${record.row.sku_id} 计算与证据`}>查看<ArrowRight size={14}/></button>{record.status !== 'normal' && <button disabled={busy} className="retail-link" aria-label={`开始调查 ${record.row.sku_id}`} onClick={() => { setInvestigationTarget(record); setPage('investigations'); }}>开始调查</button>}</td></tr>)}</tbody></table></div>
          {!filtered.length && <div className="retail-empty small">当前筛选下没有记录。可调整店铺、日期或搜索条件。</div>}
          {filtered.length > 30 && <div className="retail-pagination"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><span>{offset + 1}–{Math.min(offset + 30, filtered.length)}</span><button disabled={offset + 30 >= filtered.length} onClick={() => setOffset(offset + 30)}>下一页</button></div>}
        </section><div className="retail-footnote"><ShieldCheck size={16}/><p>支持数据计算、异常识别与只读毛利调查。模型调查需 API 连接；离线演示单独标注。审批与业务执行尚未接入，静态快照不能直接作为实时改价依据。</p></div>
      </>}
      {page === 'anomalies' && <SignalsPanel compact onInvestigate={record => { setInvestigationTarget(record); setPage('investigations'); }} snapshot={signals} request={request} busy={busy} scope={signalScope}/>}
      <footer className="retail-footer"><span>本机 SQLite 持久化 · 规则 {page === 'signals' ? signals?.ruleVersion ?? 'retail-stock-roas-v1' : snapshot?.ruleVersion ?? 'retail-margin-v1'}</span><span>{busy ? '正在处理…' : '数据查询与分析，不执行经营写入'}</span></footer>
      </>}
    </main>
    {selected && <div className="retail-detail-backdrop" onClick={() => setSelected(null)}><section className="retail-detail" role="dialog" aria-modal="true" aria-label="毛利计算与证据" onClick={event => event.stopPropagation()} tabIndex={-1} ref={detailRef} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[href],summary,[tabindex="0"]');
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === detailRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="retail-section-title"><button onClick={() => setSelected(null)} aria-label="关闭证据详情"><ArrowLeft size={17}/>返回</button><span className={`retail-badge ${selected.status}`}>{labels[selected.status]}</span></div>
      <h2>{selected.row.product_name}</h2><p>{selected.row.sku_id} · {selected.row.spec}</p><div className="retail-detail-scope">{selected.row.shop_id} / {selected.row.channel}<br/>{selected.row.date}，Asia/Shanghai 日口径</div>
      <h3>毛利计算</h3><dl className="retail-equation"><div><dt>商品单价</dt><dd>{money(selected.row.list_price_minor)}</dd></div><div><dt>− 商家券</dt><dd>{money(selected.row.coupon_minor)}</dd></div><div><dt>− 商家满减</dt><dd>{money(selected.row.full_reduction_minor)}</dd></div><div><dt>+ 平台额外结算补贴</dt><dd>{money(selected.row.subsidy_minor)}</dd></div><div className="total"><dt>商家商品收入 / 件</dt><dd>{money(selected.calculation.revenueMinor)}</dd></div><div><dt>− 商品成本 / 件</dt><dd>{money(selected.row.cost_minor)}</dd></div><div className="total"><dt>商品毛利 / 件</dt><dd>{money(selected.calculation.profitMinor)}</dd></div><div><dt>毛利率 = 商品毛利 ÷ 商品收入</dt><dd>{percent(selected.calculation.marginBps)}</dd></div></dl>
      <h3>规则与数据质量</h3>{selected.reasons.length ? <ul className="retail-reasons">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>在当前已知口径下满足 20% 毛利阈值。</p>}<p className="retail-muted">净成交 {selected.row.sold_qty} 件；现存 {selected.row.on_hand}、占用 {selected.row.reserved}、可售 {selected.calculation.available}、在途 {selected.row.inbound_qty}。在途不计入即时可售。20% 是演示规则，非通用经营标准。</p>
      <h3>证据快照</h3><dl className="retail-evidence"><dt>数据来源</dt><dd>{selected.source === 'demo' ? '合成演示数据，非真实业务结果' : '用户导入 CSV'}</dd><dt>导入时间</dt><dd>{new Date(selected.importedAt).toLocaleString('zh-CN')}</dd><dt>数据时效</dt><dd>业务日期 {selected.row.date}；仅为静态快照，不保证当前实时有效</dd><dt>记录 ID</dt><dd>{selected.id}</dd><dt>导入批次</dt><dd>{selected.batchId}</dd><dt>快照 SHA-256</dt><dd>{selected.snapshotHash}</dd><dt>规则版本</dt><dd>{selected.ruleVersion}</dd></dl>
      <details><summary>查看原始字段</summary><pre>{JSON.stringify(selected.row, null, 2)}</pre></details><button className="retail-primary" onClick={() => download(`经营证据-${selected.row.sku_id}.json`, JSON.stringify(selected, null, 2), 'application/json')}>导出证据 JSON</button>
    </section></div>}
  </div>;
}
