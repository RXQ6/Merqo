import {Database} from 'bun:sqlite';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evidenceTimeContext} from './evidence-policy';
import type {EvidenceRecord} from './operations';
import type {SignalRecord} from './signals';

import {OPERATIONAL_NAMES,type OperationalKind,type OperationalItem,type OperationalEvidence} from './operational-evidence-contract';
export type {OperationalEvidence} from './operational-evidence-contract';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LIMIT=30;
/** Read existing ledgers only. Freeze exact declared identities; never join on a product name. */
export function freezeOperationalEvidence(file:string,anchor:EvidenceRecord|SignalRecord,now=Date.now()):OperationalEvidence {
 const time=evidenceTimeContext(anchor),sourceId=anchor.provenance?.sourceId??null,spec='spec'in anchor.row?anchor.row.spec:null;
 const scope={source:anchor.source,sourceId,shop:anchor.row.shop_id,channel:anchor.row.channel,sku:anchor.row.sku_id,spec,start:time.period?.startInclusive??null,end:time.period?.endExclusive??null};
 const items:OperationalItem[]=[],truncated:OperationalKind[]=[],issues:string[]=[];
 const add=(kind:OperationalKind,rows:Record<string,unknown>[],id:(r:Record<string,unknown>)=>string,at:(r:Record<string,unknown>)=>string,context=false)=>{
  if(rows.length>LIMIT)truncated.push(kind);
  for(const record of rows.slice(0,LIMIT)){const recordId=id(record),hash=digest(record);items.push({id:'ledger:'+kind+':'+hash,kind,recordId,sourceId:sourceId!,businessAt:at(record),status:context?'context_only':'scope_matched',reasons:context?['来源、店铺、SKU和规格一致；台账未声明渠道，仅作旁证']:['声明来源、店铺、渠道、SKU、规格和窗口一致'],hash,record});}
 };
 if(!sourceId||!spec||!scope.start||!scope.end)issues.push('缺少独立来源标识、规格或业务窗口，未自动关联业务台账；请补充来源声明后重新调查。');
 else if(existsSync(file)){
  const db=new Database(file,{readonly:true,strict:true});
  try{db.exec('PRAGMA busy_timeout=5000');db.transaction(()=>{
   const has=(name:string)=>!!db.query('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(name);
   const end=Math.min(Date.parse(scope.end!),now),start=Date.parse(scope.start!);
   if(has('transaction_events')){
    const rows=db.query<{json:string},[string,string,string,number,number,string,string,string]>(`SELECT json FROM transaction_events WHERE source=? AND shop_id=? AND channel=? AND order_at>=? AND order_at<? AND json_extract(json,'$.source_id')=? AND json_extract(json,'$.sku_id')=? AND json_extract(json,'$.spec')=? AND event_at<${end} ORDER BY event_at,event_key LIMIT ${LIMIT+1}`).all(anchor.source,scope.shop,scope.channel,start,end,sourceId,scope.sku,spec).map(r=>JSON.parse(r.json) as Record<string,unknown>);
    add('transactions',rows,r=>String(r.event_id),r=>String(r.event_at));
   }
   if(anchor.source==='csv')for(const [kind,table]of [['procurement','procurement_events'],['warehouse','warehouse_events']] as const){
    if(!has(table))continue;
    // These ledgers have no source-kind or channel field. Never mix them into synthetic snapshots.
    const rows=db.query<{json:string},[string,string,string,string,number]>(`SELECT json FROM ${table} WHERE json_extract(json,'$.source_id')=? AND json_extract(json,'$.shop_id')=? AND json_extract(json,'$.sku')=? AND json_extract(json,'$.spec')=? AND julianday(json_extract(json,'$.event_at'))<julianday(?/1000.0,'unixepoch') ORDER BY julianday(json_extract(json,'$.event_at')) DESC,key LIMIT ${LIMIT+1}`).all(sourceId,scope.shop,scope.sku,spec,end).map(r=>JSON.parse(r.json) as Record<string,unknown>);
    add(kind,rows,r=>String(r.event_id),r=>String(r.event_at),true);
   }
   if(anchor.source==='csv'&&has('local_finance_events')&&has('procurement_events')){const rows=db.query<{json:string},[string,string,string,string,number]>(`SELECT f.json FROM local_finance_events f WHERE json_extract(f.json,'$.sourceId')=? AND json_extract(f.json,'$.shop')=? AND EXISTS (SELECT 1 FROM procurement_events p WHERE json_extract(p.json,'$.source_id')=json_extract(f.json,'$.sourceId') AND json_extract(p.json,'$.shop_id')=json_extract(f.json,'$.shop') AND json_extract(p.json,'$.purchase_id')=json_extract(f.json,'$.purchaseId') AND json_extract(p.json,'$.line_id')=json_extract(f.json,'$.lineId') AND json_extract(p.json,'$.kind')='planned' AND json_extract(p.json,'$.sku')=? AND json_extract(p.json,'$.spec')=?) AND julianday(f.at)<=julianday(?/1000.0,'unixepoch') ORDER BY f.at DESC,f.id LIMIT ${LIMIT+1}`).all(sourceId,scope.shop,scope.sku,spec,now).map(r=>JSON.parse(r.json) as Record<string,unknown>);add('finance',rows,r=>String(r.id),r=>String(r.at),true);}
   if(has('contribution_reports')){
    const rows=db.query<{json:string},[string,string,string]>(`SELECT json FROM contribution_reports WHERE json_extract(json,'$.report.source')=? AND (json_extract(json,'$.report.query.shop')='' OR json_extract(json,'$.report.query.shop')=?) AND (json_extract(json,'$.report.query.channel')='' OR json_extract(json,'$.report.query.channel')=?) ORDER BY rowid DESC LIMIT 101`).all(anchor.source,scope.shop,scope.channel);
    if(rows.length===101)issues.push('成本报告候选超过一百份，检索已截断；未找到不代表不存在。');
    const filtered:Record<string,unknown>[]=[];
    for(const row of rows.slice(0,100)){const v=JSON.parse(row.json).report;if(!v||v.at>now)continue;const range=evidenceTimeContext({source:anchor.source,importedAt:new Date(v.at).toISOString(),row:{date:v.query.endDate,window_days:Math.round((Date.parse(v.query.endDate)-Date.parse(v.query.startDate))/86400000)+1}}).period;if(!range||range.startInclusive!==scope.start||range.endExclusive!==scope.end)continue;
     for(const line of v.lines??[])if(line.sourceId===sourceId&&line.shopId===scope.shop&&line.channel===scope.channel&&line.sku===scope.sku&&line.spec===spec)filtered.push({reportId:v.id,at:new Date(v.at).toISOString(),ledgerHash:v.ledgerHash,line,authority:v.authority,reportLinesTruncated:v.totalLines>v.lines.length});
    }add('costs',filtered,r=>String(r.reportId)+':'+String((r.line as {lineId:string}).lineId),r=>String(r.at),true);
   }
  })();}finally{db.close();}
 }
 const missing=(Object.keys(OPERATIONAL_NAMES) as OperationalKind[]).filter(k=>!items.some(i=>i.kind===k));
 if(truncated.length)issues.push('台账记录超过每类三十条，当前为截断旁证，禁止把展示样本合计当作全范围总额。');
 issues.push('来源为本地声明，未认证平台身份或完整水位；仓库事件不等于即时库存，采购到货不自动计入可售。');
 const trade=items.filter(i=>i.kind==='transactions'),costs=items.filter(i=>i.kind==='costs'),purchases=items.filter(i=>i.kind==='procurement'),warehouse=items.filter(i=>i.kind==='warehouse');
 const findings:OperationalEvidence['findings']=[];
 if(trade.length||costs.length)findings.push({chain:'trade_contribution',title:'交易—退款—成本核对',detail:trade.length&&costs.length?'已有同范围交易和成本报告，须核对订单行、退款成熟度与报告时点；报告之间不自动相加。':'交易或成本旁证缺失，暂不能形成完整贡献结论。',itemIds:[...trade,...costs].map(i=>i.id)});
 if(purchases.length||warehouse.length)findings.push({chain:'purchase_stock',title:'采购—到货—仓库核对',detail:purchases.length&&warehouse.length?'已有同商品采购与仓库事件；入库须核对到货事件引用，渠道缺失，不自动证明库存快照一致。':'采购或仓库旁证缺失，不能推定到货已转为可售库存。',itemIds:[...purchases,...warehouse].map(i=>i.id)});
 const value={version:'operational-evidence-v1' as const,frozenAt:new Date(Math.max(Date.parse(anchor.importedAt),...items.map(i=>Date.parse(i.businessAt)))).toISOString(),scope,items,missing,truncated,issues,findings,limitation:'冻结的本地业务台账旁证；未证明完整性、因果、净利润或真实执行资格。后续导入不会改写本次调查；更新台账后通过补证创建新的调查版本。'};
 // Exclude read time: an unchanged ledger must not spuriously invalidate a supplement preview.
 return{...value,hash:digest({...value,frozenAt:undefined})};
}
