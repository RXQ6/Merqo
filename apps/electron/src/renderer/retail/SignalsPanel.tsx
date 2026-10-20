import {SourceMetadataEditor,SourceMetadataSummary,emptySourceDraft,parseSourceDraft} from './SourceMetadata';
import {ScopeEvidence} from './ScopeEvidence';
import { useEffect, useRef, useState } from 'react';
import type { SignalPage } from '../../../../../packages/retail-domain/src/signal-page';
import type { RetailReply, RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import { ADS_DEMO, INVENTORY_DEMO, ADS_FIELDS, INVENTORY_FIELDS, SIGNAL_LABELS } from '../../../../../packages/retail-domain/src/signals';
import type { AdsRow, InventoryRow, SignalKind, SignalPreview, SignalRecord, SignalSnapshot } from '../../../../../packages/retail-domain/src/signals';
const labels = { normal: '正常', warning: '经营预警', needs_evidence: '待补证' };
const ratio = (n: number | null) => n === null ? '待补证' : n.toFixed(2);
const change = (n: number | null) => n === null ? '不可比较' : `${(n / 100).toFixed(2)}%`;
function download(name: string, value: unknown, csv = false) {
  const url = URL.createObjectURL(new Blob([csv ? '\uFEFF' + String(value) : JSON.stringify(value, null, 2)], { type: csv ? 'text/csv;charset=utf-8' : 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SignalsPanel({ snapshot, request, busy, scope, onInvestigate, compact = false, refreshKey = 0 }: {
  onInvestigate: (record: SignalRecord) => void; snapshot: SignalSnapshot | null; request: (r: RetailRequest) => Promise<RetailReply | undefined>; busy: boolean;
  scope: { source: 'demo' | 'csv'; shop: string; channel: string; date: string; query: string }; compact?: boolean; refreshKey?: number;
}) {
  const [kind, setKind] = useState<SignalKind>('inventory'); const [preview, setPreview] = useState<SignalPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}); const [csv, setCsv] = useState(''); const [error, setError] = useState('');
  const [sourceDraft,setSourceDraft]=useState(emptySourceDraft);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<'all' | 'normal' | 'warning' | 'needs_evidence'>('all');
  const [pages, setPages] = useState<{ inventory: SignalPage; ads: SignalPage } | null>(null);
  const [loading, setLoading] = useState(true);
  const filterKey = JSON.stringify([scope.source, scope.shop, scope.channel, scope.date, compact ? scope.query : query, status, compact, refreshKey]);
  const [pagination, setPagination] = useState({ key: '', inventory: 0, ads: 0 });
  const inventoryOffset = pagination.key === filterKey ? pagination.inventory : 0;
  const adsOffset = pagination.key === filterKey ? pagination.ads : 0;
  const [loadedKey, setLoadedKey] = useState('');
  const currentKey = JSON.stringify([filterKey, inventoryOffset, adsOffset]);
  const currentPages = loadedKey === currentKey ? pages : null;
  useEffect(() => {
    setPagination(current => current.key === filterKey ? current : { key: filterKey, inventory: 0, ads: 0 });
  }, [filterKey]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    const timer = setTimeout(() => {
      const common = { source: scope.source, shop: scope.shop, channel: scope.channel, date: scope.date, search: compact ? scope.query : query, status: compact ? 'anomalies' as const : status, limit: 30 };
      void Promise.all([
        request({ op: 'signals_page', ...common, kind: 'inventory', offset: inventoryOffset }),
        request({ op: 'signals_page', ...common, kind: 'ads', offset: adsOffset }),
      ]).then(([inventory, ads]) => {
        if (disposed) return;
        if (inventory?.ok && inventory.kind === 'signals_page' && ads?.ok && ads.kind === 'signals_page') {
          setPages({ inventory: inventory.data, ads: ads.data }); setLoadedKey(currentKey);
        }
        setLoading(false);
      });
    }, 100);
    return () => { disposed = true; clearTimeout(timer); };
  }, [request, scope.source, scope.shop, scope.channel, scope.date, scope.query, compact, query, status, refreshKey, inventoryOffset, adsOffset, currentKey]);
  const input = useRef<HTMLInputElement>(null);
  const fields = kind === 'inventory' ? INVENTORY_FIELDS : ADS_FIELDS;
  const rows = currentPages ? [...currentPages.inventory.records, ...currentPages.ads.records] : [];
  const summary = currentPages ? { inventory: currentPages.inventory.pagination.summary.inventory, ads: currentPages.ads.pagination.summary.ads } : null;
  const unavailable = busy || loading || !currentPages;
  const batches = currentPages?.inventory.batches ?? snapshot?.batches ?? [];
  const validate = async (text: string, proposed?: Record<string, string>) => {
    const result = await request({ op: 'signals_preview', kind, csv: text, ...(proposed ? { mapping: proposed } : {}) });
    if (result?.ok && result.kind === 'signals_preview') { setPreview(result.data); setMapping(result.data.mapping); }
  };
  const importRows = async () => {try{const metadata=parseSourceDraft(sourceDraft);const reply = await request({ op: 'signals_import', kind, csv, mapping,...(metadata?{sourceMetadata:metadata}:{}) }); if (reply?.ok) { setPreview(null); setCsv('');setSourceDraft(emptySourceDraft()); }}catch(cause){setError(cause instanceof Error?cause.message:'来源元数据无效');} };
  const renderTable = (k: SignalKind) => {
    const records = rows.filter(r => r.kind === k);
    const info = currentPages?.[k].pagination;
    const setOffset = (offset: number) => setPagination({ key: filterKey, inventory: inventoryOffset, ads: adsOffset, [k]: offset });
    return <section className="retail-panel" key={k} data-testid={`signals-${k}`} aria-busy={loading}><div className="retail-section-title"><div><h2>{k === 'inventory' ? '销量与缺货风险' : '广告回报下降'}</h2><p>{k === 'inventory' ? '观察净销量、即时可售、补货交期与预计到货；在途不计入即时可售。' : '相邻等长窗口、相同归因口径比较 ROAS；归因成交额不代表利润。'}</p></div><span>{info ? `${info.total} 条快照` : '读取中…'}</span></div>
      <ScopeEvidence value={info?.scopeEvidence} kind={k}/>{!records.length ? <p className="retail-muted" role="status">{loading ? '正在读取场景数据…' : !currentPages ? '读取失败，请刷新重试。' : '当前范围没有记录。可载入演示数据或切换数据来源。'}</p> : <div className="retail-table-wrap"><table><thead><tr><th>业务实体 / 窗口</th><th>{k === 'inventory' ? '可售 / 覆盖天数' : '当前 / 对照 ROAS'}</th><th>{k === 'inventory' ? '销量变化' : 'ROAS 相对变化'}</th><th>状态与线索</th><th>证据</th></tr></thead><tbody>{records.map(r => <tr key={r.id}><td><strong>{r.row.sku_id}</strong><small>{r.row.shop_id} / {r.row.channel}</small><small>{k === 'inventory' ? (r.row as InventoryRow).warehouse_id : (r.row as AdsRow).campaign_id}</small><small>{r.row.date} / {r.row.window_days ?? '?'} 天；对照 {r.row.baseline_end_date} / {r.row.baseline_window_days ?? '?'} 天</small></td>
        <td>{k === 'inventory' ? `${r.metrics.available ?? '待补证'} / ${ratio(r.metrics.coverageDays)} 天` : `${ratio(r.metrics.roas)} / ${ratio(r.metrics.baselineRoas)}`}</td><td>{change(k === 'inventory' ? r.metrics.salesChangeBps : r.metrics.roasChangeBps)}</td>
        <td><span className={`retail-badge ${r.status === 'warning' ? 'low_margin' : r.status}`}>{labels[r.status]}</span><small className="retail-signal-reasons">{r.metrics.issues.length ? r.metrics.issues.join('；') : r.metrics.flags.join('；') || '未触发演示规则'}</small></td><td><SignalEvidence record={r}/>{r.status !== 'normal' && <button disabled={unavailable} className="retail-link" aria-label={`开始调查 ${r.row.sku_id} ${r.kind}`} onClick={() => onInvestigate(r)}>开始调查</button>}</td></tr>)}</tbody></table></div>}
      <div className="retail-inline-actions" aria-label={`${k === 'inventory' ? '库存' : '广告'}分页`}><button disabled={unavailable || !info || info.offset === 0} onClick={() => setOffset(Math.max(0, (info?.offset ?? 0) - 30))}>上一页</button><span>{info ? `${info.total ? info.offset + 1 : 0}–${info.offset + records.length} / ${info.total}` : '—'}</span><button disabled={unavailable || !info || info.offset + info.limit >= info.total} onClick={() => setOffset((info?.offset ?? 0) + 30)}>下一页</button><button disabled={unavailable || !records.length} onClick={() => download(`${k}-当前页证据.json`, { records, pagination: info })}>导出当前页证据</button></div>
    </section>;
  };
  return <section data-testid="retail-signals">
    <div className="retail-section-title"><div><h2>{compact ? '库存与广告异常' : '库存与广告数据'}</h2><p>{summary ? `范围内库存预警 ${summary.inventory.warning} 条；广告预警 ${summary.ads.warning} 条；待补证 ${summary.inventory.missing + summary.ads.missing} 条。计数不受搜索、状态和分页影响。` : '正在读取范围计数…'}来源：{scope.source === 'demo' ? '合成演示' : 'CSV 导入'}。</p></div><button disabled={busy} onClick={() => void request({ op: 'signals_demo' })}>载入库存与广告演示</button></div>
    {!compact && scope.source==='demo'&&<div className="retail-inline-actions"><button disabled={busy} onClick={()=>void request({op:'signals_replenishment_demo'})}>载入补货执行演示</button><span className="retail-muted">合成样例改为1天交期，可走通补货请求；原5天样例仍会阻断到货前缺口。</span></div>}
    {!compact && <>
      <div className="retail-inline-actions retail-signal-actions"><label>导入类型 <select aria-label="场景导入类型" value={kind} onChange={e => { setKind(e.target.value as SignalKind);setSourceDraft(emptySourceDraft()); setPreview(null); setCsv(''); setError(''); }}><option value="inventory">库存与销量</option><option value="ads">广告回报</option></select></label><button disabled={busy} onClick={() => input.current?.click()}>选择场景 CSV</button><button onClick={() => download(`${kind}-模板.csv`, kind === 'inventory' ? INVENTORY_DEMO : ADS_DEMO, true)}>下载当前场景模板</button></div>
      <input ref={input} type="file" className="retail-file-input" accept=".csv,text/csv" aria-label="选择库存或广告 CSV" onChange={e => { const file = e.target.files?.[0];setSourceDraft(emptySourceDraft()); e.target.value = ''; if (!file) return; setError(''); setPreview(null); if (file.size > 32000000) { setError('文件超过 32 MB'); return; } void file.text().then(text => { setCsv(text); return validate(text); }).catch(() => setError('无法读取 CSV，请使用 UTF-8')); }}/>
      {error && <div role="alert" className="retail-alert error">{error}</div>}
      {preview && <section className="retail-panel" aria-label="场景导入预览"><SourceMetadataEditor value={sourceDraft} onChange={setSourceDraft}/><div className="retail-section-title"><h2>场景导入预览</h2><span>总计 {preview.total} 行，有效 {preview.validCount ?? preview.valid.length} 行，隔离 {preview.rejectedCount ?? preview.rejected.length} 行</span></div><div className="retail-mappings">{fields.map(f => <label key={f}>{SIGNAL_LABELS[f]}<select aria-label={`场景映射 ${SIGNAL_LABELS[f]}`} value={mapping[f] ?? ''} onChange={e => { setMapping(v => ({ ...v, [f]: e.target.value })); setPreview(v => v ? { ...v, valid: [], validCount: 0 } : null); }}><option value="">选择列</option>{preview.headers.map(h => <option key={h}>{h}</option>)}</select></label>)}</div>
        {!!preview.rejected.length && <ul className="retail-rejected">{preview.rejected.slice(0, 30).map(r => <li key={r.line}>第 {r.line} 行：{r.reason}</li>)}</ul>}
        <div className="retail-inline-actions"><button disabled={busy} onClick={() => void validate(csv, mapping)}>重新校验场景映射</button><button className="retail-primary" disabled={busy || !preview.valid.length} onClick={() => void importRows()}>导入 {preview.validCount ?? preview.valid.length} 条场景数据</button></div></section>}
      <div className="retail-table-toolbar"><input aria-label="搜索库存或广告" placeholder="搜索 SKU、仓库或 Campaign" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="库存广告状态" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">全部状态</option><option value="warning">经营预警</option><option value="needs_evidence">待补证</option><option value="normal">正常</option></select></div>
    </>}
    {renderTable('inventory')}{renderTable('ads')}
    {!compact && <section className="retail-panel"><div className="retail-section-title"><h2>场景导入批次与质量报告</h2></div>{batches.map(b => <div className="retail-signal-batch" key={b.id}><span>{b.kind === 'inventory' ? '库存' : '广告'} / {b.source === 'demo' ? '演示' : 'CSV'} · {new Date(b.importedAt).toLocaleString('zh-CN')} · 有效 {b.accepted} / 隔离 {b.rejected}</span><button onClick={() => download(`场景质量-${b.id}.json`, b)}>导出质量报告</button></div>)}</section>}
  </section>;
}
function SignalEvidence({ record: r }: { record: SignalRecord }) {
  return <details className="retail-signal-evidence"><summary aria-label={`查看 ${r.row.sku_id} ${r.kind} 场景证据`}>查看</summary><div><SourceMetadataSummary provenance={r.provenance}/><strong>规则与口径</strong><ul>{[...r.metrics.flags, ...r.metrics.issues, ...r.metrics.notes].map((n, i) => <li key={i}>{n}</li>)}</ul><p>来源：{r.source === 'demo' ? '合成演示，非真实业务结果' : '用户 CSV'}；导入 {new Date(r.importedAt).toLocaleString('zh-CN')}</p><p>规则：{r.ruleVersion}<br/>批次：{r.batchId}<br/>SHA-256：{r.hash}</p><pre>{JSON.stringify({ row: r.row, calculation: r.metrics }, null, 2)}</pre></div></details>;
}
