import { useRef, useState } from 'react';
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
export function SignalsPanel({ snapshot, request, busy, scope, onInvestigate, compact = false }: {
  onInvestigate: (record: SignalRecord) => void; snapshot: SignalSnapshot | null; request: (r: RetailRequest) => Promise<RetailReply | undefined>; busy: boolean;
  scope: { source: 'demo' | 'csv'; shop: string; channel: string; date: string; query: string }; compact?: boolean;
}) {
  const [kind, setKind] = useState<SignalKind>('inventory'); const [preview, setPreview] = useState<SignalPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}); const [csv, setCsv] = useState(''); const [error, setError] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all');
  const input = useRef<HTMLInputElement>(null);
  const fields = kind === 'inventory' ? INVENTORY_FIELDS : ADS_FIELDS;
  const rows = (snapshot?.records ?? []).filter(r => r.source === scope.source && (!scope.shop || r.row.shop_id === scope.shop) && (!scope.channel || r.row.channel === scope.channel) && (!scope.date || r.row.date === scope.date) && (!compact || r.status !== 'normal') && (!query || JSON.stringify(r.row).toLowerCase().includes(query.toLowerCase())) && (!scope.query || JSON.stringify(r.row).toLowerCase().includes(scope.query.toLowerCase())) && (status === 'all' || r.status === status));
  const validate = async (text: string, proposed?: Record<string, string>) => {
    const result = await request({ op: 'signals_preview', kind, csv: text, ...(proposed ? { mapping: proposed } : {}) });
    if (result?.ok && result.kind === 'signals_preview') { setPreview(result.data); setMapping(result.data.mapping); }
  };
  const importRows = async () => { const reply = await request({ op: 'signals_import', kind, csv, mapping }); if (reply?.ok) { setPreview(null); setCsv(''); } };
  const renderTable = (k: SignalKind) => {
    const records = rows.filter(r => r.kind === k);
    return <section className="retail-panel" key={k} data-testid={`signals-${k}`}><div className="retail-section-title"><div><h2>{k === 'inventory' ? '销量与缺货风险' : '广告回报下降'}</h2><p>{k === 'inventory' ? '观察净销量、即时可售、补货交期与预计到货；在途不计入即时可售。' : '相邻等长窗口、相同归因口径比较 ROAS；归因成交额不代表利润。'}</p></div><span>{records.length} 条快照</span></div>
      {!records.length ? <p className="retail-muted">当前范围没有记录。可载入演示数据或切换数据来源。</p> : <div className="retail-table-wrap"><table><thead><tr><th>业务实体 / 窗口</th><th>{k === 'inventory' ? '可售 / 覆盖天数' : '当前 / 对照 ROAS'}</th><th>{k === 'inventory' ? '销量变化' : 'ROAS 相对变化'}</th><th>状态与线索</th><th>证据</th></tr></thead><tbody>{records.slice(0, 100).map(r => <tr key={r.id}><td><strong>{r.row.sku_id}</strong><small>{r.row.shop_id} / {r.row.channel}</small><small>{k === 'inventory' ? (r.row as InventoryRow).warehouse_id : (r.row as AdsRow).campaign_id}</small><small>{r.row.date} / {r.row.window_days ?? '?'} 天；对照 {r.row.baseline_end_date} / {r.row.baseline_window_days ?? '?'} 天</small></td>
        <td>{k === 'inventory' ? `${r.metrics.available ?? '待补证'} / ${ratio(r.metrics.coverageDays)} 天` : `${ratio(r.metrics.roas)} / ${ratio(r.metrics.baselineRoas)}`}</td><td>{change(k === 'inventory' ? r.metrics.salesChangeBps : r.metrics.roasChangeBps)}</td>
        <td><span className={`retail-badge ${r.status === 'warning' ? 'low_margin' : r.status}`}>{labels[r.status]}</span><small className="retail-signal-reasons">{r.metrics.issues.length ? r.metrics.issues.join('；') : r.metrics.flags.join('；') || '未触发演示规则'}</small></td><td><SignalEvidence record={r}/>{r.status !== 'normal' && <button disabled={busy} className="retail-link" aria-label={`开始调查 ${r.row.sku_id} ${r.kind}`} onClick={() => onInvestigate(r)}>开始调查</button>}</td></tr>)}</tbody></table></div>}
      {records.length > 100 && <p className="retail-muted">显示前 100 条，请用 SKU、店铺或日期缩小范围；“导出当前证据”包含全部筛选结果。</p>}
    </section>;
  };
  return <section data-testid="retail-signals">
    <div className="retail-section-title"><div><h2>{compact ? '库存与广告异常' : '库存与广告数据'}</h2><p>库存预警 {rows.filter(r => r.kind === 'inventory' && r.status === 'warning').length} 条；广告预警 {rows.filter(r => r.kind === 'ads' && r.status === 'warning').length} 条；待补证 {rows.filter(r => r.status === 'needs_evidence').length} 条。来源：{scope.source === 'demo' ? '合成演示' : 'CSV 导入'}。</p></div><button disabled={busy} onClick={() => void request({ op: 'signals_demo' })}>载入库存与广告演示</button></div>
    {!compact && <>
      <div className="retail-inline-actions retail-signal-actions"><label>导入类型 <select aria-label="场景导入类型" value={kind} onChange={e => { setKind(e.target.value as SignalKind); setPreview(null); setCsv(''); setError(''); }}><option value="inventory">库存与销量</option><option value="ads">广告回报</option></select></label><button disabled={busy} onClick={() => input.current?.click()}>选择场景 CSV</button><button onClick={() => download(`${kind}-模板.csv`, kind === 'inventory' ? INVENTORY_DEMO : ADS_DEMO, true)}>下载当前场景模板</button><button disabled={!rows.length} onClick={() => download('库存与广告证据.json', rows)}>导出当前证据</button></div>
      <input ref={input} type="file" className="retail-file-input" accept=".csv,text/csv" aria-label="选择库存或广告 CSV" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setError(''); setPreview(null); if (file.size > 2000000) { setError('文件超过 2 MB'); return; } void file.text().then(text => { setCsv(text); return validate(text); }).catch(() => setError('无法读取 CSV，请使用 UTF-8')); }}/>
      {error && <div role="alert" className="retail-alert error">{error}</div>}
      {preview && <section className="retail-panel" aria-label="场景导入预览"><div className="retail-section-title"><h2>场景导入预览</h2><span>总计 {preview.total} 行，有效 {preview.valid.length} 行，隔离 {preview.rejected.length} 行</span></div><div className="retail-mappings">{fields.map(f => <label key={f}>{SIGNAL_LABELS[f]}<select aria-label={`场景映射 ${SIGNAL_LABELS[f]}`} value={mapping[f] ?? ''} onChange={e => { setMapping(v => ({ ...v, [f]: e.target.value })); setPreview(v => v ? { ...v, valid: [] } : null); }}><option value="">选择列</option>{preview.headers.map(h => <option key={h}>{h}</option>)}</select></label>)}</div>
        {!!preview.rejected.length && <ul className="retail-rejected">{preview.rejected.slice(0, 30).map(r => <li key={r.line}>第 {r.line} 行：{r.reason}</li>)}</ul>}
        <div className="retail-inline-actions"><button disabled={busy} onClick={() => void validate(csv, mapping)}>重新校验场景映射</button><button className="retail-primary" disabled={busy || !preview.valid.length} onClick={() => void importRows()}>导入 {preview.valid.length} 条场景数据</button></div></section>}
      <div className="retail-table-toolbar"><input aria-label="搜索库存或广告" placeholder="搜索 SKU、仓库或 Campaign" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="库存广告状态" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option><option value="warning">经营预警</option><option value="needs_evidence">待补证</option><option value="normal">正常</option></select></div>
    </>}
    {renderTable('inventory')}{renderTable('ads')}
    {!compact && <section className="retail-panel"><div className="retail-section-title"><h2>场景导入批次与质量报告</h2></div>{snapshot?.batches.map(b => <div className="retail-signal-batch" key={b.id}><span>{b.kind === 'inventory' ? '库存' : '广告'} / {b.source === 'demo' ? '演示' : 'CSV'} · {new Date(b.importedAt).toLocaleString('zh-CN')} · 有效 {b.accepted} / 隔离 {b.rejected}</span><button onClick={() => download(`场景质量-${b.id}.json`, b)}>导出质量报告</button></div>)}</section>}
  </section>;
}
function SignalEvidence({ record: r }: { record: SignalRecord }) {
  return <details className="retail-signal-evidence"><summary aria-label={`查看 ${r.row.sku_id} ${r.kind} 场景证据`}>查看</summary><div><strong>规则与口径</strong><ul>{[...r.metrics.flags, ...r.metrics.issues, ...r.metrics.notes].map((n, i) => <li key={i}>{n}</li>)}</ul><p>来源：{r.source === 'demo' ? '合成演示，非真实业务结果' : '用户 CSV'}；导入 {new Date(r.importedAt).toLocaleString('zh-CN')}</p><p>规则：{r.ruleVersion}<br/>批次：{r.batchId}<br/>SHA-256：{r.hash}</p><pre>{JSON.stringify({ row: r.row, calculation: r.metrics }, null, 2)}</pre></div></details>;
}
