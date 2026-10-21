import type {RetailPagination} from '../../../../../packages/retail-domain/src/retail-query';
import {SourceMetadataSummary} from './SourceMetadata';
export function ScopeEvidence({value,kind='margin'}:{value:RetailPagination['scopeEvidence'];kind?:'margin'|'inventory'|'ads'}) {
 return <section className="retail-scope-evidence" aria-label="当前统计范围与来源">
  <h2>统计口径与来源</h2>
  <p className="retail-scope-date">快照业务日期 <strong>{value?.businessStart??'无记录'} 至 {value?.businessEnd??'无记录'}</strong><span>北京时间</span></p>
  <p className="retail-muted">范围统计不受搜索、异常状态或分页影响；日期范围不代表其中每一天的数据已完整。</p>
  <details className="retail-method-note"><summary>查看计算口径与限制</summary>
  <p>{kind==='margin'?'缺证快照不计入金额合计。商家商品收入包含已声明的平台结算补贴；商品毛利未扣广告、运费及平台佣金，不等于净利润。':kind==='inventory'?'每条快照按其观察窗和对照窗计算；即时可售不含在途，零销量覆盖不可计算；不跨仓自动合并。':'每条快照按其等长相邻观察窗及归因口径比较ROAS，归因收入不等于利润；不跨活动自动合并。'}导入时间不能替代源观测或完整截止。</p>
  </details>
  {value?.truncated&&<p role="status">来源批次超过30个，仅展示前30个；不能据此认定全部来源已经完整。</p>}
  {!value?.batches.length&&<p>当前范围没有来源批次。</p>}
  {value?.batches.map(batch=><details key={batch.batchId}><summary>来源批次 · 当前范围 {batch.count} 条快照 · {batch.provenance?.sourceName??'未声明来源'}</summary><p>批次：{batch.batchId}；导入：{batch.importedAt}</p><SourceMetadataSummary provenance={batch.provenance}/></details>)}
 </section>;
}
