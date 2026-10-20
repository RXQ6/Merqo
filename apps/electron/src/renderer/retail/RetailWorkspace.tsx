import {SourceMetadataEditor,SourceMetadataSummary,emptySourceDraft,parseSourceDraft} from './SourceMetadata';
import { selectOffers } from '../../../../../packages/retail-domain/src/offers';
import {CatalogPanel} from './CatalogPanel';
import {ScopeEvidence} from './ScopeEvidence';
import {TransactionsPanel} from './TransactionsPanel';
import {PolicyPanel} from './PolicyPanel';
import { ChecksPanel } from './ChecksPanel';
import { ReviewsPanel } from './ReviewsPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Boxes, CircleAlert, FileSpreadsheet, LayoutDashboard, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { DEMO_CSV, BUNDLE_DEMO_CSV, NESTED_BUNDLE_DEMO_CSV, GIFT_DEMO_CSV, MEMBER_DEMO_CSV, OFFER_DEMO_CSV, exportCsv, effectivePrice, giftCost, hasGiftFields, IMPORT_FIELDS, OPTIONAL_FIELDS, FIELD_LABELS } from '../../../../../packages/retail-domain/src/operations';
import {BundleTree} from './BundleTree';
import type { EvidenceRecord, Preview, RetailRequest, RetailReply, Snapshot } from '../../../../../packages/retail-domain/src/operations';
import { useRegisterDismissibleLayer } from '@/context/DismissibleLayerContext';
import { SignalsPanel } from './SignalsPanel';
import type { SignalSnapshot, SignalRecord } from '../../../../../packages/retail-domain/src/signals';
import type { ExecutionView } from '../../../../../packages/retail-domain/src/simulation';
import { CompensationsPanel } from './CompensationsPanel';
import { ExecutionBatchesPanel } from './ExecutionBatchesPanel';
import { ExecutionsPanel } from './ExecutionsPanel';
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
export function RetailWorkspace({ onOpenAgent, workspaceName, active = true }: { onOpenAgent: () => void; workspaceName?: string; active?: boolean }) {
  const followupReview=useCallback((run:AnyInvestigation)=>{setInvestigationTarget(null);setInvestigationId(run.id);setPage('investigations');},[]);
  const [investigationId,setInvestigationId]=useState<string|null>(null);
  const [reviewJobId,setReviewJobId]=useState<string|null>(null);
  const [compensationTarget,setCompensationTarget]=useState<ExecutionView|null>(null);
  const [executionRequestId, setExecutionRequestId] = useState<string | null>(null);
  const [approvalRequestId,setApprovalRequestId] = useState<string | null>(null);
  const [decisionTarget,setDecisionTarget] = useState<AnyInvestigation | null>(null);
  const [investigationTarget, setInvestigationTarget] = useState<EvidenceRecord | SignalRecord | null>(null);
  const [signals, setSignals] = useState<SignalSnapshot | null>(null);
  const [signalRefreshKey, setSignalRefreshKey] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<'catalog' | 'transactions' | 'policy' | 'overview' | 'anomalies' | 'data' | 'investigations' | 'signals' | 'decisions' | 'approvals' | 'executions' | 'compensations' | 'batches' | 'reviews' | 'checks'>('overview');
  const [source, setSource] = useState<'demo' | 'csv'>('demo');
  const [shop, setShop] = useState(''); const [channel, setChannel] = useState(''); const [date, setDate] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<EvidenceRecord | null>(null);
  const offerSelection = useMemo(() => selected ? selectOffers(selected.row) : null, [selected]);
  useRegisterDismissibleLayer(useMemo(() => active && selected ? {
    id: 'retail-evidence', type: 'modal' as const, priority: 100,
    close: () => setSelected(null),
  } : null, [selected, active]));
  const detailRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false); const pending = useRef(false);
  const requestQueue = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null); const [mapping, setMapping] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const queryGeneration = useRef(0);
  const [sourceDraft,setSourceDraft]=useState(emptySourceDraft);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useCallback(async (input: RetailRequest): Promise<RetailReply | undefined> => {
    const generation = queryGeneration.current;
    const previous = requestQueue.current;
    let release!: () => void;
    requestQueue.current = new Promise<void>(resolve => { release = resolve; });
    await previous;
    pending.current = true; setBusy(true); setError('');
    if (input.op !== 'snapshot' && input.op !== 'signals' && input.op !== 'signals_page') setNotice('');
    try {
      const reply = await window.electronAPI.retailRequest(input);
      if (!reply.ok) throw new Error(reply.error);
      if (reply.kind === 'signals') { setSignals(reply.data); if (reply.notice) setNotice(reply.notice); if (input.op === 'signals_import' || input.op === 'signals_demo') { setSource(input.op === 'signals_import' ? 'csv' : 'demo'); setShop(''); setChannel(''); setDate(''); } }
      if (reply.kind === 'snapshot' && (input.op !== 'snapshot' || generation === queryGeneration.current)) { setSnapshot(reply.data); if (reply.signals) setSignals(reply.signals); if (reply.notice) setNotice(reply.notice); }
      if (input.op === 'signals_import' || input.op === 'signals_demo' || input.op === 'signals_replenishment_demo' || input.op === 'demo' || input.op === 'import') setSignalRefreshKey(value => value + 1);
      return reply;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请求失败，请重试'); return; }
    finally { pending.current = false; setBusy(false); release(); }
  }, []);
  useEffect(() => {
    if (page !== 'signals') return;
    let disposed = false;
    void request({ op: 'signals_page', source, shop, channel, date, search: '', status: 'all', offset: 0, limit: 30 }).then(reply => {
      if (!disposed && reply?.ok && reply.kind === 'signals_page') setSignals(reply.data);
    });
    return () => { disposed = true; };
  }, [request, page, source, shop, channel, date, signalRefreshKey]);
  useEffect(() => {
    queryGeneration.current++;
    if (page !== 'overview' && page !== 'anomalies' && page !== 'data') return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      if (disposed) return;
      if (pending.current) { timer = setTimeout(load, 50); return; }
      void request({ op: 'snapshot', source, shop, channel, date, search: query, offset, limit: 30, status: status === 'all' ? page === 'anomalies' ? 'anomalies' : 'all' : status as 'normal' | 'low_margin' | 'needs_evidence' });
    };
    timer = setTimeout(load, 100);
    return () => { disposed = true; clearTimeout(timer); };
  }, [request, source, shop, channel, date, query, status, offset, page]);
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
  const signalSummary = signals?.pagination?.summary;
  const signalFacets = signals?.pagination?.facets;
  const signalCount = signalSummary ? signalSummary.inventory.warning + signalSummary.inventory.missing + signalSummary.ads.warning + signalSummary.ads.missing : signals?.records.filter(r => r.source === source && r.status !== 'normal' && (!shop || r.row.shop_id === shop) && (!channel || r.row.channel === channel) && (!date || r.row.date === date)).length ?? 0;
  const known = scoped.filter(record => record.status !== 'needs_evidence');
  const summary = snapshot?.pagination?.summary;
  const revenue = summary ? BigInt(summary.revenueMinor) : known.reduce((sum, record) => sum + BigInt(record.calculation.totalRevenueMinor ?? 0), 0n);
  const profit = summary ? BigInt(summary.profitMinor) : known.reduce((sum, record) => sum + BigInt(record.calculation.totalProfitMinor ?? 0), 0n);
  const warning = summary?.warning ?? scoped.filter(record => record.status === 'low_margin').length;
  const missing = summary?.missing ?? scoped.filter(record => record.status === 'needs_evidence').length;
  const totalRows = snapshot?.pagination?.total ?? filtered.length;
  const currentOffset = snapshot?.pagination?.offset ?? offset;
  const latest = (page === 'signals' ? signals?.batches : snapshot?.batches)?.filter(batch => batch.source === source)[0];
  const loadingFirst = page !== 'signals' && busy && !snapshot;
  const loadDemo = async () => { const reply = await request({ op: 'demo' }); if (reply?.ok) { setSource('demo'); setShop(''); setChannel(''); setDate(''); } };
  const openCsv = async (file: File) => {
    setError(''); setNotice(''); setPreview(null);setSourceDraft(emptySourceDraft());
    if (file.size > 32_000_000) { setError('文件超过 32 MB，请缩小范围'); return; }
    try {
      const text = await file.text(); setCsv(text); setFileName(file.name);
      const result = await request({ op: 'preview', csv: text });
      if (result?.ok && result.kind === 'preview') { setMapping(result.data.mapping); setPreview(result.data); setPage('data'); }
    } catch { setError('无法读取文件，请使用 UTF-8 编码的 CSV'); }
  };
  const validateMapping = async () => { const result = await request({ op: 'preview', csv, mapping }); if (result?.ok && result.kind === 'preview') setPreview(result.data); };
  const importRows = async () => {
    try{const metadata=parseSourceDraft(sourceDraft);const result = await request({ op: 'import', csv, mapping,...(metadata?{sourceMetadata:metadata}:{}) });
    if (result?.ok) { setSource('csv'); setShop(''); setChannel(''); setDate(''); setPreview(null); setCsv('');setSourceDraft(emptySourceDraft()); }
    }catch(cause){setError(cause instanceof Error?cause.message:'来源元数据无效');}
  };
  const updateMapping = (key: string, value: string) => { setMapping(current => ({ ...current, [key]: value })); setPreview(current => current ? { ...current, valid: [] } : null); };
  return <div className="retail-app" data-testid="retail-workspace">
    <header className="retail-windowbar"><div className="retail-wordmark"><Boxes size={19}/><strong>Merqo</strong><span>经营分析</span></div><div className="retail-windowbar-actions"><span>{workspaceName??'当前工作空间'}</span><button onClick={onOpenAgent}>返回会话</button></div></header>
    <div className="retail-window-layout">
    <aside className="retail-navigation"><nav aria-label="经营导航">
      <p className="retail-nav-group">经营洞察</p>
      <button aria-current={page === 'overview' ? 'page' : undefined} onClick={() => { setPage('overview'); setStatus('all'); }}><LayoutDashboard size={16}/>经营总览</button>
      <button aria-current={page === 'anomalies' ? 'page' : undefined} onClick={() => { setPage('anomalies'); setStatus('all'); }}><CircleAlert size={16}/>异常中心<span className="retail-tab-count">{warning + missing + signalCount}</span></button>
      <button aria-current={page === 'signals' ? 'page' : undefined} onClick={() => { setQuery(''); setPage('signals'); }}><Boxes size={16}/>库存与广告</button>
      <button aria-current={page === 'investigations' ? 'page' : undefined} onClick={() => { setInvestigationTarget(null); setInvestigationId(null); setPage('investigations'); }}>调查记录</button>
      <button aria-current={page === 'checks' ? 'page' : undefined} onClick={() => setPage('checks')}>经营巡检</button>
      <p className="retail-nav-group">决策执行</p>
      <button aria-current={page === 'decisions' ? 'page' : undefined} onClick={() => { setDecisionTarget(null); setPage('decisions'); }}>决策草稿</button>
      <button aria-current={page === 'approvals' ? 'page' : undefined} onClick={() => { setApprovalRequestId(null); setPage('approvals'); }}>审批中心</button>
      <button aria-current={page === 'executions' || page === 'batches' || page === 'reviews' ? 'page' : undefined} onClick={() => { setExecutionRequestId(null); setPage('executions'); }}>执行记录</button>
      <button aria-current={page === 'compensations' ? 'page' : undefined} onClick={() => { setCompensationTarget(null); setPage('compensations'); }}>补偿记录</button>
      <p className="retail-nav-group">数据管理</p><button aria-current={page==='catalog'?'page':undefined} onClick={()=>setPage('catalog')}>商品映射</button><button aria-current={page==='transactions'?'page':undefined} onClick={()=>setPage('transactions')}>交易与退款</button>
      <button aria-current={page === 'data' ? 'page' : undefined} onClick={() => setPage('data')}><FileSpreadsheet size={16}/>数据与导入</button>
      <button aria-current={page==='policy'?'page':undefined} onClick={()=>setPage('policy')}>经营规则</button>
    </nav><p className="retail-navigation-note">本地经营工作台<br/><span>分析与模拟执行</span></p></aside>
    <main className="retail-main">
      {page==='catalog'?<CatalogPanel request={request}/>:page==='transactions'?<TransactionsPanel request={request}/>:page==='policy'?<PolicyPanel request={request} onChanged={()=>{setSignalRefreshKey(v=>v+1);void request({op:'snapshot',source,status:'all',search:'',offset:0,limit:30});}}/>:page === 'checks' ? <ChecksPanel onAnomalies={() => { setPage('anomalies'); setStatus('all'); }}/> : page === 'reviews' ? <ReviewsPanel onFollowup={followupReview} jobId={reviewJobId} onBack={()=>setPage('executions')}/> : page === 'batches' ? <ExecutionBatchesPanel onBack={()=>setPage('executions')}/> : page === 'compensations' ? <CompensationsPanel target={compensationTarget} onBack={()=>setPage('executions')}/> : page === 'executions' ? <ExecutionsPanel onReview={jobId=>{setReviewJobId(jobId);setPage('reviews');}} onBatches={()=>setPage('batches')} onCompensation={item=>{setCompensationTarget(item);setPage('compensations');}} initialRequestId={executionRequestId} onBack={() => setPage('approvals')}/> : page === 'approvals' ? <ApprovalsPanel onExecution={id => { setExecutionRequestId(id); setPage('executions'); }} initialRequestId={approvalRequestId} onBack={() => { setDecisionTarget(null); setPage('decisions'); }}/> : page === 'decisions' ? <DecisionsPanel onInvestigation={id=>{setInvestigationTarget(null);setInvestigationId(id);setPage('investigations');}} target={decisionTarget} onBack={() => setPage('overview')} onApproval={id => { setApprovalRequestId(id); setPage('approvals'); }}/> : page === 'investigations' ? <InvestigationPanel onData={()=>setPage('data')} initialId={investigationId} target={investigationTarget} onBack={() => setPage('overview')} onDraft={run => { setDecisionTarget(run); setPage('decisions'); }}/> : <>
      <header className="retail-header"><div><h1>{page === 'overview' ? '商品毛利分析' : page === 'anomalies' ? '经营异常' : page === 'signals' ? '库存与广告' : '经营数据'}</h1><p>{page === 'data' ? '导入前预览并检查口径，错误行隔离，历史快照保留。' : page === 'signals' ? '按相邻等长窗口核对销量、库存覆盖与广告回报。' : page === 'anomalies' ? '按店铺、渠道与经营日期核对三类异常及证据。' : '按店铺、渠道与经营日期核对商品收入、成本和优惠。'}</p></div>
        <div className="retail-header-actions"><button disabled={busy} onClick={() => { setSignalRefreshKey(value => value + 1); if (page !== 'signals') void request({ op: 'snapshot', source, shop, channel, date, search: query, offset, limit: 30, status: status === 'all' ? page === 'anomalies' ? 'anomalies' : 'all' : status as 'normal' | 'low_margin' | 'needs_evidence' }); }} aria-label="刷新经营数据"><RefreshCw size={17}/></button><button className="retail-primary" disabled={busy} onClick={() => { if (page === 'signals') document.querySelector<HTMLInputElement>('input[aria-label="选择库存或广告 CSV"]')?.click(); else { setPage('data'); fileInput.current?.click(); } }}><FileSpreadsheet size={16}/>{page === 'signals' ? '导入场景 CSV' : '导入毛利 CSV'}</button></div>
      </header>
      <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="选择经营 CSV 文件" className="retail-file-input" onChange={event => { const file = event.target.files?.[0]; if (file) void openCsv(file); event.target.value = ''; }}/>
      {error && <div className="retail-alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误"><X size={16}/></button></div>}
      {notice && <div className="retail-alert success" role="status">{notice}</div>}
      <div className="retail-scope"><label>数据来源<select aria-label="数据来源" value={source} onChange={event => { setSource(event.target.value as 'demo' | 'csv'); setShop(''); setChannel(''); setDate(''); }}><option value="demo">演示数据</option><option value="csv">CSV 导入数据</option></select></label>
        <label>店铺<select aria-label="店铺" value={shop} onChange={event => setShop(event.target.value)}><option value="">全部店铺</option>{[...new Set([...(snapshot?.pagination?.facets.shops ?? []), ...(signalFacets?.shops ?? []), ...scopeRows.map(row => row.shop_id)])].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>渠道<select aria-label="渠道" value={channel} onChange={event => setChannel(event.target.value)}><option value="">全部渠道</option>{[...new Set([...(snapshot?.pagination?.facets.channels ?? []), ...(signalFacets?.channels ?? []), ...scopeRows.map(row => row.channel)])].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>经营日期<select aria-label="经营日期" value={date} onChange={event => setDate(event.target.value)}><option value="">全部日期</option>{[...new Set([...(snapshot?.pagination?.facets.dates ?? []), ...(signalFacets?.dates ?? []), ...scopeRows.map(row => row.date)])].sort().reverse().map(value => <option key={value}>{value}</option>)}</select></label>
        <span className="retail-scope-note">{source === 'demo' ? '合成快照，非实时经营数据' : '静态导入快照，非实时同步'}<small>{latest ? `最近导入 ${new Date(latest.importedAt).toLocaleString('zh-CN')}` : '尚未载入数据'}</small></span>
      </div>
      {loadingFirst ? <div className="retail-empty" role="status">正在读取本机经营数据…</div> : page === 'signals' ? <SignalsPanel refreshKey={signalRefreshKey} onInvestigate={record => { setInvestigationId(null);setInvestigationTarget(record); setPage('investigations'); }} snapshot={signals} request={request} busy={busy} scope={signalScope}/> : page === 'data' ? <>
        <section className="retail-import-intro"><div><h2>先确认数据口径，再开始分析</h2><p>一行代表一个店铺、渠道、SKU 在某个经营日期的快照。金额单位为“分”，净成交件数已扣除退款。商品毛利不包含广告、运费与平台佣金。</p><div className="retail-inline-actions"><button className="retail-primary" disabled={busy} onClick={() => fileInput.current?.click()}>选择 CSV 文件</button><button onClick={() => download('RetailPilot-经营快照模板.csv', '\uFEFF' + DEMO_CSV)}>下载带示例的模板</button><button onClick={() => download('Merqo-组合装示例.csv', '\uFEFF' + BUNDLE_DEMO_CSV)}>下载组合装示例</button><button onClick={() => download('Merqo-嵌套组合装示例.csv', '\uFEFF' + NESTED_BUNDLE_DEMO_CSV)}>下载嵌套组合装示例</button><button onClick={() => download('Merqo-赠品示例.csv', '\uFEFF' + GIFT_DEMO_CSV)}>下载赠品示例</button><button onClick={() => download('Merqo-会员价示例.csv', '\uFEFF' + MEMBER_DEMO_CSV)}>下载会员价示例</button><button onClick={() => download('Merqo-可售报价示例.csv', '\uFEFF' + OFFER_DEMO_CSV)}>下载可售报价示例</button><button disabled={busy} onClick={() => void loadDemo()}>载入演示数据</button></div><p>组合装需声明 product_type=bundle，并提供子 SKU、规格、数量和单位成本 JSON。金额和销量按每销售包核算，子项合计必须等于整包成本。可用 children 声明嵌套子项，最多6层、500子项；每层合计须等于父项单位成本。</p><p>赠品需声明 gift_policy=free_per_unit、gift_cost_basis=additional，并提供 gifts 明细。每销售件免费附赠，主商品成本不含赠品成本；券与满减全部计主商品，赠品收入为零。</p><p>会员价通过 membership JSON 声明单一会员分组、身份、价格、有效期和叠加规则。净成交数量必须只属于该分组；同 SKU 同日不混合多个会员分组。</p><p>参考报价使用 offers JSON。仅比较同范围、同规格、同业务日期的明确可售公开报价；无货排除，未知待补证。筛选价不替换成交价，不触发改价。</p></div><FileSpreadsheet size={56}/></section>
        {preview && <section className="retail-panel" aria-label="导入预览"><SourceMetadataEditor value={sourceDraft} onChange={setSourceDraft}/><div className="retail-section-title"><div><h2>导入预览 · {fileName}</h2><p>总计 {preview.total} 行，有效 {(preview.validCount ?? preview.valid.length)} 行，隔离 {preview.rejected.length} 行，其中重复 {preview.duplicateCount} 行。</p></div><button onClick={() => setPreview(null)} aria-label="关闭导入预览"><X size={18}/></button></div>
          <div className="retail-mappings">{IMPORT_FIELDS.map(key => <label key={key}>{FIELD_LABELS[key]}<select aria-label={`映射 ${FIELD_LABELS[key]}`} value={mapping[key] ?? ''} onChange={event => updateMapping(key, event.target.value)}><option value="">{OPTIONAL_FIELDS.some(field => field === key) ? '未提供（可选）' : '选择列'}</option>{preview.headers.map(header => <option key={header}>{header}</option>)}</select></label>)}</div>
          <div className="retail-table-wrap"><table><caption>CSV 原始内容预览（前 4 行）</caption><thead><tr>{preview.headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.sample.map((row, index) => <tr key={index}>{row.map((value, col) => <td key={col}>{value || '空值'}</td>)}</tr>)}</tbody></table></div>
          {!!preview.rejected.length && <details open><summary>错误行与隔离原因（显示前 30 条）</summary><ul className="retail-rejected">{preview.rejected.slice(0, 30).map(item => <li key={item.line}>第 {item.line} 条记录：{item.reason}</li>)}</ul></details>}
          <div className="retail-inline-actions"><button disabled={busy} onClick={() => void validateMapping()}>重新校验映射</button><button className="retail-primary" disabled={busy || !(preview.validCount ?? preview.valid.length)} onClick={() => void importRows()}>导入 {(preview.validCount ?? preview.valid.length)} 条有效数据</button></div>
        </section>}
        <section className="retail-panel"><div className="retail-section-title"><h2>导入记录与数据健康</h2><span>有效数据入库，错误行独立留档</span></div>{!snapshot?.batches.length ? <p className="retail-muted">还没有导入记录。可以先载入演示数据。</p> : <div className="retail-table-wrap"><table><thead><tr><th>来源</th><th>导入时间</th><th>有效</th><th>隔离</th><th>快照摘要</th><th>质量报告</th></tr></thead><tbody>{snapshot.batches.map(batch => <tr key={batch.id}><td>{batch.source === 'demo' ? '演示数据' : 'CSV 文件'}</td><td>{new Date(batch.importedAt).toLocaleString('zh-CN')}</td><td>{batch.accepted}</td><td>{batch.rejected}</td><td title={batch.hash}>{batch.hash.slice(0, 12)}</td><td><button className="retail-link" onClick={() => download(`导入质量报告-${batch.id}.json`, JSON.stringify(batch, null, 2), 'application/json')}>导出报告</button></td></tr>)}</tbody></table></div>}</section>
      </> : !sourceRows.length ? <section className="retail-empty"><Boxes size={46}/><h2>{source === 'demo' ? '从一组可核对的经营数据开始' : '还没有 CSV 经营数据'}</h2><p>查看优惠叠加如何影响毛利，区分真实预警与证据缺口。</p><div className="retail-inline-actions"><button className="retail-primary" disabled={busy} onClick={() => void loadDemo()}>载入演示数据</button><button onClick={() => { setPage('data'); fileInput.current?.click(); }}>导入自己的 CSV</button></div></section> : <>
        <div className="retail-metrics" aria-label="经营指标"><div><span>商家商品收入</span><strong>{money(revenue)}</strong><small>已具备完整证据的 {summary?.known ?? known.length} / {summary?.total ?? scoped.length} 条快照</small></div><div><span>商品毛利</span><strong>{money(profit)}</strong><small>商品收入减成本，不等同净利润</small></div><div><span>毛利预警</span><strong className="retail-danger">{warning}<em>条</em></strong><small>按当前经营规则核验；默认阈值 {(snapshot?.thresholdBps ?? 2000) / 100}% ，店铺可独立配置</small></div><div><span>待补证</span><strong className="retail-amber">{missing}<em>条</em></strong><small>不计入收入与毛利合计</small></div></div>
        <ScopeEvidence value={snapshot?.pagination?.scopeEvidence}/>
        <section className="retail-panel"><div className="retail-section-title"><div><h2>{page === 'anomalies' ? '异常快照' : '商品经营快照'}</h2><p>先核对同规格、同期间数据，再判断经营动作。</p></div><button disabled={!filtered.length} onClick={() => download('RetailPilot-经营异常与证据.csv', exportCsv(filtered))}><ArrowDownToLine size={16}/>导出当前页结果</button></div>
          <div className="retail-table-toolbar"><label className="retail-search"><Search size={16}/><input aria-label="搜索商品或 SKU" placeholder="搜索商品、规格或 SKU" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="异常状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="low_margin">毛利预警</option><option value="needs_evidence">待补证</option>{page !== 'anomalies' && <option value="normal">正常</option>}</select><span>{totalRows} 条快照</span></div>
          <div className="retail-table-wrap"><table><thead><tr><th>商品与规格</th><th>店铺 / 日期</th><th>成交件数</th><th>商品收入 / 件</th><th>毛利率</th><th>可售 / 在途</th><th>状态</th><th>证据 / 调查</th></tr></thead><tbody>{(snapshot?.pagination ? filtered : filtered.slice(offset, offset + 30)).map(record => <tr key={record.id}><td><strong>{record.row.product_name}</strong><small>{record.row.sku_id} · {record.row.spec}</small></td><td>{record.row.shop_id}<small>{record.row.date}</small></td><td>{record.row.sold_qty}</td><td>{money(record.calculation.revenueMinor)}</td><td className={record.status === 'low_margin' ? 'retail-danger' : ''}>{percent(record.calculation.marginBps)}</td><td>{record.calculation.available} / {record.row.inbound_qty}</td><td><span className={`retail-badge ${record.status}`}>{labels[record.status]}</span></td><td><button className="retail-link" onClick={() => setSelected(record)} aria-label={`查看 ${record.row.sku_id} 计算与证据`}>查看<ArrowRight size={14}/></button>{record.status !== 'normal' && <button disabled={busy} className="retail-link" aria-label={`开始调查 ${record.row.sku_id}`} onClick={() => { setInvestigationId(null);setInvestigationTarget(record); setPage('investigations'); }}>开始调查</button>}</td></tr>)}</tbody></table></div>
          {!filtered.length && <div className="retail-empty small">当前筛选下没有记录。可调整店铺、日期或搜索条件。</div>}
          {totalRows > 30 && <div className="retail-pagination"><button disabled={busy || currentOffset === 0} onClick={() => setOffset(Math.max(0, currentOffset - 30))}>上一页</button><span>{currentOffset + 1}–{Math.min(currentOffset + 30, totalRows)} / {totalRows}</span><button disabled={busy || currentOffset + 30 >= totalRows} onClick={() => setOffset(currentOffset + 30)}>下一页</button></div>}
        </section><div className="retail-footnote"><ShieldCheck size={16}/><p>支持三场景只读调查、版本草稿与本地模拟审批执行。模型调查需配置连接；离线演示单独标注。静态快照不构成真实经营写入授权。</p></div>
      </>}
      {page === 'anomalies' && <SignalsPanel refreshKey={signalRefreshKey} compact onInvestigate={record => { setInvestigationId(null);setInvestigationTarget(record); setPage('investigations'); }} snapshot={signals} request={request} busy={busy} scope={signalScope}/>}
      <footer className="retail-footer"><span>本机 SQLite 持久化 · 规则 {page === 'signals' ? signals?.ruleVersion ?? 'retail-stock-roas-v1' : snapshot?.ruleVersion ?? 'retail-margin-v1'}</span><span>{busy ? '正在处理…' : '数据查询与分析，不执行经营写入'}</span></footer>
      </>}
    </main>
    </div>
    {selected && <div className="retail-detail-backdrop" onClick={() => setSelected(null)}><section className="retail-detail" role="dialog" aria-modal="true" aria-label="毛利计算与证据" onClick={event => event.stopPropagation()} tabIndex={-1} ref={detailRef} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[href],summary,[tabindex="0"]');
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === detailRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="retail-section-title"><button onClick={() => setSelected(null)} aria-label="关闭证据详情"><ArrowLeft size={17}/>返回</button><span className={`retail-badge ${selected.status}`}>{labels[selected.status]}</span></div>
      <h2>{selected.row.product_name}</h2><p>{selected.row.sku_id} · {selected.row.spec}</p><div className="retail-detail-scope">{selected.row.shop_id} / {selected.row.channel}<br/>{selected.row.date}，Asia/Shanghai 日口径</div>
      <SourceMetadataSummary provenance={selected.provenance}/><h3>毛利计算</h3><dl className="retail-equation"><div><dt>普通商品单价</dt><dd>{money(selected.row.list_price_minor)}</dd></div>{selected.row.membership !== undefined && <div><dt>本快照适用单价</dt><dd>{money(effectivePrice(selected.row))}</dd></div>}<div><dt>− 商家券</dt><dd>{money(selected.row.coupon_minor)}</dd></div><div><dt>− 商家满减</dt><dd>{money(selected.row.full_reduction_minor)}</dd></div><div><dt>+ 平台额外结算补贴</dt><dd>{money(selected.row.subsidy_minor)}</dd></div><div className="total"><dt>商家商品收入 / 件</dt><dd>{money(selected.calculation.revenueMinor)}</dd></div><div><dt>− 商品成本 / 件</dt><dd>{money(selected.row.cost_minor)}</dd></div>{hasGiftFields(selected.row) && <div><dt>− 赠品成本 / 销售件</dt><dd>{money(giftCost(selected.row))}</dd></div>}<div className="total"><dt>商品毛利 / 件</dt><dd>{money(selected.calculation.profitMinor)}</dd></div><div><dt>毛利率 = 商品毛利 ÷ 商品收入</dt><dd>{percent(selected.calculation.marginBps)}</dd></div></dl>
      {selected.row.offers !== undefined && offerSelection && <><h3>可售参考报价</h3><p>{offerSelection.status === 'selected' ? '筛选参考价：' + money(offerSelection.selectedPriceMinor) : '报价待补证'}{offerSelection.selectedOfferId ? ' · ' + offerSelection.selectedOfferId : ''}</p><ul>{selected.row.offers?.map((offer, index) => <li key={index}>{offer.offer_id} · {offer.spec} · {money(offer.price_minor)} · {offer.available === true ? '声明有货' : offer.available === false ? '无货' : '可售未知'}{offerSelection.excluded.find(excluded => excluded.offerId === offer.offer_id) ? '；排除：' + offerSelection.excluded.find(excluded => excluded.offerId === offer.offer_id)!.reason : ''}</li>)}</ul>{offerSelection.issues.length > 0 && <ul>{offerSelection.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}<p className="retail-muted">{offerSelection.limitation}</p></>}{selected.row.membership !== undefined && <><h3>会员价格上下文</h3><p>身份：{selected.row.membership?.status === 'member' ? '会员' : selected.row.membership?.status === 'non_member' ? '非会员' : '未知'}；分组：{selected.row.membership?.segment_id ?? '未提供'}</p><p>会员价 {money(selected.row.membership?.price_minor ?? null)}；有效期 [{selected.row.membership?.valid_from ?? '未知'}, {selected.row.membership?.valid_to ?? '未知'})</p><p>优惠规则：{selected.row.membership?.discount_policy === 'stackable' ? '允许叠加' : selected.row.membership?.discount_policy === 'exclusive' ? '与券和满减互斥' : '未知'}</p><p className="retail-muted">按业务日期核对有效期。仅为单一分组快照，不代表真实会员认证或跨分组汇总。</p></>}{hasGiftFields(selected.row) && <><h3>赠品关联（每销售件）</h3><p>赠送规则：{selected.row.gift_policy ?? '未声明'}；成本口径：{selected.row.gift_cost_basis ?? '未声明'}</p>{selected.row.gifts?.length ? <ul>{selected.row.gifts.map((gift, index) => <li key={index}>{gift.sku_id} · {gift.spec} × {gift.quantity}；单位成本 {money(gift.unit_cost_minor)}</li>)}</ul> : <p>{selected.row.gift_policy === 'none' ? '明确无赠品' : '缺少赠品明细，须补证'}</p>}<p className="retail-muted">仅支持每件免费附赠、赠品成本另计；赠品收入为零，优惠全部计主商品。不处理订单门槛与逐单分摊。</p></>}{selected.row.product_type === 'bundle' && <><h3>组合装子项（每销售包）</h3>{selected.row.bundle_components?.length ? <BundleTree parts={selected.row.bundle_components}/> : <p>缺少子项映射，须补证。</p>}<p className="retail-muted">子项成本继承当前店铺、渠道、日期与 CNY。整包收入与优惠不分摊到子项；最多6层、500子项，每层成本核对；不自动拆分库存或收入。</p></>}<h3>规则与数据质量</h3>{selected.reasons.length ? <ul className="retail-reasons">{selected.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>在当前已知口径下满足 20% 毛利阈值。</p>}<p className="retail-muted">净成交 {selected.row.sold_qty} 件；现存 {selected.row.on_hand}、占用 {selected.row.reserved}、可售 {selected.calculation.available}、在途 {selected.row.inbound_qty}。在途不计入即时可售。20% 是演示规则，非通用经营标准。</p>
      <h3>证据快照</h3><dl className="retail-evidence"><dt>数据来源</dt><dd>{selected.source === 'demo' ? '合成演示数据，非真实业务结果' : '用户导入 CSV'}</dd><dt>导入时间</dt><dd>{new Date(selected.importedAt).toLocaleString('zh-CN')}</dd><dt>数据时效</dt><dd>业务日期 {selected.row.date}；仅为静态快照，不保证当前实时有效</dd><dt>记录 ID</dt><dd>{selected.id}</dd><dt>导入批次</dt><dd>{selected.batchId}</dd><dt>快照 SHA-256</dt><dd>{selected.snapshotHash}</dd><dt>规则版本</dt><dd>{selected.ruleVersion}</dd></dl>
      <details><summary>查看原始字段</summary><pre>{JSON.stringify(selected.row, null, 2)}</pre></details><button className="retail-primary" onClick={() => download(`经营证据-${selected.row.sku_id}.json`, JSON.stringify(selected, null, 2), 'application/json')}>导出证据 JSON</button>
    </section></div>}
  </div>;
}

