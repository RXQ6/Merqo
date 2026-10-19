import {createHash} from 'node:crypto';import type {AnyInvestigation} from './investigations';import type {EvidenceRecord} from './operations';import type {SignalRecord} from './signals';import type {RelatedEvidence} from './related-evidence';
export interface SupplementPreview{parentId:string;expectedEpoch:number;round:number;hash:string;before:EvidenceRecord|SignalRecord;after:EvidenceRecord|SignalRecord;relatedEvidence?:RelatedEvidence;notice:string}
export function freshSupplementEvidence(parent:AnyInvestigation,candidates:Iterable<EvidenceRecord|SignalRecord>):EvidenceRecord|SignalRecord{
 const old=parent.evidence;const matches=[...candidates].filter(e=>e.source===old.source&&('kind'in e?e.kind:'margin')===(parent.scenario??'margin')&&(['shop_id','channel','sku_id','date'] as const).every(k=>e.row[k]===old.row[k])&&(!('warehouse_id'in old.row)||('warehouse_id'in e.row&&e.row.warehouse_id===old.row.warehouse_id))&&(!('campaign_id'in old.row)||('campaign_id'in e.row&&e.row.campaign_id===old.row.campaign_id)));
 if(matches.length!==1)throw Error('原实体范围内无唯一新版证据，请先导入同店铺、渠道、SKU、业务日及仓库/活动的数据');const fresh=matches[0]!;
 if('spec'in old.row&&(!('spec'in fresh.row)||fresh.row.spec!==old.row.spec))throw Error('新版规格与原调查不一致，请作为独立商品重新调查');
 if(old.provenance&&fresh.provenance?.sourceId!==old.provenance.sourceId)throw Error('新版独立来源标识变化，请作为新来源重新调查');
 return fresh;
}
export function supplementDigest(parent:AnyInvestigation,evidence:EvidenceRecord|SignalRecord,relatedEvidence?:RelatedEvidence):string{return createHash('sha256').update(JSON.stringify({parentId:parent.id,epoch:parent.epoch??0,evidence,relatedEvidence})).digest('hex');}
