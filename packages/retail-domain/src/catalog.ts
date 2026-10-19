import {z} from 'zod';
import type {EvidenceRecord} from './operations';import type {SignalRecord} from './signals';
const text=z.string().trim().min(1).max(200),day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const t=Date.parse(s+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===s;});
export const CatalogEntryInputSchema=z.strictObject({id:z.string().uuid().optional(),source:z.enum(['demo','csv']),sourceId:text,shopId:text,channel:text,scenario:z.enum(['margin','inventory','ads']),sourceSku:text,sourceSpec:text.nullable(),campaignId:text.nullable(),canonicalSku:text,canonicalSpec:text,validFrom:day,validThrough:day,enabled:z.boolean()}).refine(e=>e.validFrom<=e.validThrough,{message:'映射生效开始不能晚于结束'}).refine(e=>e.scenario==='ads'||e.sourceSpec!==null,{message:'销售和库存映射必须明确原规格'}).refine(e=>e.scenario==='ads'||e.campaignId===null,{message:'只有广告映射可限制活动'});
export const CatalogEntrySchema=CatalogEntryInputSchema.safeExtend({id:z.string().uuid()});
export type CatalogEntry=z.infer<typeof CatalogEntrySchema>;
export const CatalogUpdateSchema=z.strictObject({op:z.literal('catalog_update'),expectedRevision:z.number().int().min(0),entry:CatalogEntryInputSchema,reason:text});
export interface CatalogSnapshot{revision:number;entries:CatalogEntry[];at:string|null;reason:string;actor:'builtin'|'local-simulation-admin'}
export interface CatalogView{current:CatalogSnapshot;history:Array<{revision:number;at:string|null;reason:string}>}
export const emptyCatalog=():CatalogSnapshot=>({revision:0,entries:[],at:null,reason:'尚无显式商品映射',actor:'builtin'});
type Evidence=EvidenceRecord|SignalRecord;
const scenario=(e:Evidence)=>'kind'in e?e.kind:'margin';
export function applicableMappings(e:Evidence,catalog:CatalogSnapshot):CatalogEntry[]{return catalog.entries.filter(m=>m.enabled&&m.source===e.source&&m.sourceId===e.provenance?.sourceId&&m.shopId===e.row.shop_id&&m.channel===e.row.channel&&m.scenario===scenario(e)&&m.sourceSku===e.row.sku_id&&m.validFrom<=e.row.date&&m.validThrough>=e.row.date&&m.sourceSpec===('spec'in e.row?e.row.spec:null)&&(m.campaignId===null||('campaign_id'in e.row&&m.campaignId===e.row.campaign_id)));}
export interface CatalogIdentity{sku:string;spec:string|null;mapping:CatalogEntry|null;revision:number;issues:string[]}
export function resolveCatalogIdentity(e:Evidence,catalog:CatalogSnapshot):CatalogIdentity{
 const matches=applicableMappings(e,catalog);
 if(matches.length===1){const m=matches[0]!;return{sku:m.canonicalSku,spec:m.canonicalSpec,mapping:m,revision:catalog.revision,issues:[]};}
 return{sku:e.row.sku_id,spec:'spec'in e.row?e.row.spec:null,mapping:null,revision:catalog.revision,issues:matches.length>1?['商品映射存在歧义，禁止合并']:[]};
}
export function catalogCandidateSkus(e:Evidence,catalog:CatalogSnapshot):string[]{const identity=resolveCatalogIdentity(e,catalog);return [...new Set([e.row.sku_id,...catalog.entries.filter(m=>m.enabled&&m.source===e.source&&m.shopId===e.row.shop_id&&m.channel===e.row.channel&&m.canonicalSku===identity.sku&&m.canonicalSpec===identity.spec&&m.validFrom<=e.row.date&&m.validThrough>=e.row.date).map(m=>m.sourceSku)])];}
export function mappingOverlap(a:CatalogEntry,b:CatalogEntry):boolean{return a.enabled&&b.enabled&&a.source===b.source&&a.sourceId===b.sourceId&&a.shopId===b.shopId&&a.channel===b.channel&&a.scenario===b.scenario&&a.sourceSku===b.sourceSku&&a.sourceSpec===b.sourceSpec&&(a.campaignId===null||b.campaignId===null||a.campaignId===b.campaignId)&&a.validFrom<=b.validThrough&&b.validFrom<=a.validThrough;}
