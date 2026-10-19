import {evidenceTimeContext,evidenceTimeIssue} from './evidence-policy';import {sourceMetadataIssues} from './source-metadata';
import {resolveCatalogIdentity} from './catalog';import type {CatalogSnapshot,CatalogIdentity} from './catalog';
import type {EvidenceRecord} from './operations';import type {SignalRecord} from './signals';import type {RelatedEvidence} from './related-evidence';
type Evidence=EvidenceRecord|SignalRecord;
const scene=(e:Evidence)=>'kind'in e?e.kind:'margin';
type Period={startInclusive:string;endExclusive:string};
const samePeriod=(a:Period|null,b:Period|null)=>!!a&&!!b&&Date.parse(a.startInclusive)===Date.parse(b.startInclusive)&&Date.parse(a.endExclusive)===Date.parse(b.endExclusive);
export interface JointAssessment{status:'descriptive_comparison'|'needs_evidence';catalogRevision:number;canonicalSku:string;canonicalSpec:string|null;commonPeriod:Period|null;completeThroughExclusive:string|null;coverageStartInclusive:string|null;sourceIds:string[];issues:string[];findings:Array<{scenario:'margin'|'inventory'|'ads';evidenceId:string;notes:string[]}>;limitation:string}
function sourceIssues(e:Evidence):string[]{const t=evidenceTimeContext(e);return [...sourceMetadataIssues(e.provenance,t.period,t.baselinePeriod).filter(s=>!s.includes('未独立验证平台身份')), ...(evidenceTimeIssue(e)?[evidenceTimeIssue(e)!]:[])];}
function identityIssues(a:CatalogIdentity,b:CatalogIdentity):string[]{return [...a.issues,...b.issues,...(!a.spec||!b.spec?['缺少可核对规格']:a.spec!==b.spec?['统一规格不一致，禁止合并']:[]),...(a.sku!==b.sku?['统一SKU不一致，禁止合并']:[])];}
export function matchJointEvidence(anchor:Evidence,candidates:Iterable<Evidence>,catalog:CatalogSnapshot):RelatedEvidence{
 const items:RelatedEvidence['items']=[],counts=new Map<string,number>();let truncated=false;const anchorIdentity=resolveCatalogIdentity(anchor,catalog),anchorTime=evidenceTimeContext(anchor);
 for(const candidate of candidates){
  const kind=scene(candidate);if(kind===scene(anchor)||candidate.source!==anchor.source||candidate.row.shop_id!==anchor.row.shop_id||candidate.row.channel!==anchor.row.channel||candidate.row.date!==anchor.row.date)continue;
  const identity=resolveCatalogIdentity(candidate,catalog);if(candidate.row.sku_id!==anchor.row.sku_id&&identity.sku!==anchorIdentity.sku)continue;
  counts.set(kind,(counts.get(kind)??0)+1);if(items.filter(i=>i.scenario===kind).length>=20){truncated=true;continue;}
  const t=evidenceTimeContext(candidate),reasons=[...identityIssues(anchorIdentity,identity),...sourceIssues(anchor),...sourceIssues(candidate)];
  if(!samePeriod(anchorTime.period,t.period))reasons.push('业务窗口缺失或不一致，禁止合并');
  if('kind'in anchor&&'kind'in candidate&&!samePeriod(anchorTime.baselinePeriod,t.baselinePeriod))reasons.push('对照窗口缺失或不一致，禁止合并');
  if(anchor.status==='needs_evidence'||candidate.status==='needs_evidence')reasons.push('主证据或旁证存在数据质量缺口');
  if(('product_type'in anchor.row&&anchor.row.product_type==='bundle')||('product_type'in candidate.row&&candidate.row.product_type==='bundle'))reasons.push('组合装跨场景映射未核验');
  items.push({scenario:kind,evidence:candidate,timeContext:t,status:reasons.length?'context_only':'aligned',reasons:[...new Set(reasons)],identity});
 }
 for(const item of items)if((counts.get(item.scenario)??0)>1){item.status='context_only';item.reasons.push('同场景存在多条记录，仓库或活动范围待确认，禁止自动汇总');}
 items.sort((a,b)=>a.scenario.localeCompare(b.scenario)||a.evidence.id.localeCompare(b.evidence.id));
 const missingScenarios=(['margin','inventory','ads'] as const).filter(k=>k!==scene(anchor)&&!counts.has(k));
 const evidence=[anchor,...items.map(i=>i.evidence)],sources=evidence.flatMap(e=>e.provenance?[e.provenance]:[]),issues=[...sourceIssues(anchor),...anchorIdentity.issues,...items.flatMap(i=>i.reasons),...missingScenarios.map(k=>`缺少${k}场景证据`),...(truncated?['旁证已截断，不能判定完整联合范围']:[])];
 const inventory=evidence.find(e=>'kind'in e&&e.kind==='inventory'),ads=evidence.find(e=>'kind'in e&&e.kind==='ads');
 if(inventory&&ads&&!samePeriod(evidenceTimeContext(inventory).baselinePeriod,evidenceTimeContext(ads).baselinePeriod))issues.push('库存与广告的对照窗口不一致');
 const start=sources.length===evidence.length?sources.reduce((a,p)=>Date.parse(p.coverageStartInclusive)>Date.parse(a)?p.coverageStartInclusive:a,sources[0]!.coverageStartInclusive):null;
 const end=sources.length===evidence.length?sources.reduce((a,p)=>Date.parse(p.completeThroughExclusive)<Date.parse(a)?p.completeThroughExclusive:a,sources[0]!.completeThroughExclusive):null;
 if(start&&end&&Date.parse(start)>=Date.parse(end))issues.push('各来源覆盖范围没有共同交集');
 if(anchorTime.period&&start&&end&&(Date.parse(start)>Date.parse(anchorTime.period.startInclusive)||Date.parse(end)<Date.parse(anchorTime.period.endExclusive)))issues.push('最慢来源水位未覆盖共同业务窗口');
 const joint:JointAssessment={status:issues.length?'needs_evidence':'descriptive_comparison',catalogRevision:catalog.revision,canonicalSku:anchorIdentity.sku,canonicalSpec:anchorIdentity.spec,commonPeriod:anchorTime.period&&evidence.every(e=>samePeriod(evidenceTimeContext(e).period,anchorTime.period))?anchorTime.period:null,completeThroughExclusive:end,coverageStartInclusive:start,sourceIds:[...new Set(sources.map(p=>p.sourceId))].sort(),issues:[...new Set(issues)],findings:evidence.map(e=>({scenario:scene(e),evidenceId:e.id,notes:'kind'in e?[...e.metrics.flags,...e.metrics.issues]:e.reasons})),limitation:'仅可作冻结窗口内的并列描述，不证明因果、净利润、真实平台身份或执行资格。CSV来源及商品映射均为本地声明；不自动汇总多仓库或多广告活动。'};
 return{version:'related-evidence-v2',items,missingScenarios,truncated,joint,anchorIdentity,limitation:joint.limitation};
}
