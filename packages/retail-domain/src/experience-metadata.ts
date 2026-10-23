import type {Database} from 'bun:sqlite';
import {businessDigest} from './business-identity';
import {BriefOutput,anomalyNames,type ProductProfile,type CaseProfile,type MorningBrief,type RankedCase} from './experience-enhancement';
import type {BusinessCase,BusinessEvidence,EntitySummary} from './workbench-contract';
import type {MorningSnapshot} from './experience-contract';
export class ExperienceMetadata {
 constructor(private db:Database,private workspace:string){}
 all<T>(kind:string,scope?:string):T[]{const rows=scope===undefined?this.db.query<{json:string},[string,string]>('SELECT json FROM wb_experience WHERE workspace_id=? AND kind=? ORDER BY at DESC,id DESC LIMIT 500').all(this.workspace,kind):this.db.query<{json:string},[string,string,string]>('SELECT json FROM wb_experience WHERE workspace_id=? AND kind=? AND scope=? ORDER BY at DESC,id DESC LIMIT 500').all(this.workspace,kind,scope);return rows.map(r=>JSON.parse(r.json) as T);}
 put(kind:string,id:string,scope:string,value:unknown){this.db.query('INSERT INTO wb_experience VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET at=excluded.at,json=excluded.json').run(this.workspace,kind,id,scope,new Date().toISOString(),JSON.stringify(value));}
 product(id:string):ProductProfile{return this.all<ProductProfile>('product_profile',id)[0]??{version:0,category:'',tags:[],updatedAt:''};}
 profile(c:BusinessCase,evidence?:BusinessEvidence):CaseProfile{return this.all<CaseProfile>('case_profile',c.id)[0]??{version:0,category:this.product(c.task.task.entityKey).category,tags:c.bindings.filter(b=>b.item.kind==='tag').map(b=>b.item.title.slice(0,30)).slice(0,10),anomalies:evidence?[anomalyOf(evidence)].filter((v):v is keyof typeof anomalyNames=>!!v):[],conditions:'',exclusions:'',validFrom:'',validTo:'',enabled:true,updatedAt:''};}
 ranked(cases:BusinessCase[],target:EntitySummary,evidence:BusinessEvidence|undefined,getEvidence:(c:BusinessCase)=>BusinessEvidence|undefined,search:string,category:string,useFeedback:boolean,manage:boolean):RankedCase[]{
  const product=this.product(target.id),anomaly=evidence?anomalyOf(evidence):null,feedback=new Map(this.all<{caseId:string;helpful:boolean;reason:string;profileHash?:string}>('feedback',target.id).map(f=>[f.caseId,f]));
  return cases.filter(c=>c.task.task.scope.scenario===target.scope.scenario&&(category==='all'||c.category===category)).flatMap(item=>{
   const s=item.task.task.scope,profile=this.profile(item,getEvidence(item));const eligible=profile.enabled&&(!profile.validFrom||target.scope.date>=profile.validFrom)&&(!profile.validTo||target.scope.date<=profile.validTo);if(!eligible&&!manage)return[];
   if(!`${item.title} ${item.lesson} ${s.sku} ${profile.category} ${profile.tags.join(' ')} ${profile.conditions}`.toLowerCase().includes(search.toLowerCase()))return[];
   const reasons=['相同经营场景'],differences:string[]=eligible?[]:['已停用或不在业务日期有效期内，仅供维护'];let baseScore=30;
   if(s.sku===target.scope.sku){baseScore+=30;reasons.push('相同商品标识');}else differences.push('商品不同');
   if(s.shop===target.scope.shop){baseScore+=10;reasons.push('同店铺');}else differences.push('店铺不同');
   if(s.sourceId&&s.sourceId===target.scope.sourceId){baseScore+=20;reasons.push('同声明来源');}else differences.push('来源身份不同或未声明');
   if(product.category&&profile.category===product.category){baseScore+=15;reasons.push('相同品类：'+product.category);}else if(profile.category)differences.push('品类不同或当前商品未分类');
   if(anomaly&&profile.anomalies.includes(anomaly)){baseScore+=20;reasons.push('相同异常类型：'+anomalyNames[anomaly]);}else if(profile.anomalies.length)differences.push('异常类型不同或尚不明确');
   const shared=profile.tags.filter(t=>product.tags.includes(t));if(shared.length){baseScore+=Math.min(15,shared.length*5);reasons.push('共同标签：'+shared.join('、'));}
   if(s.date!==target.scope.date)differences.push('业务日期不同');if(s.spec!==target.scope.spec)differences.push('规格不同');if(s.warehouse!==target.scope.warehouse)differences.push('仓库不同');if(s.campaign!==target.scope.campaign)differences.push('广告活动不同');
   if(profile.conditions||profile.exclusions)differences.push('适用条件与不适用情形须人工核对');differences.push(item.category==='simulation'?'仅为模拟案例':'结果为人工声明，未证明因果');
   const profileHash=businessDigest(profile),f=feedback.get(item.id),current=!!f&&(f.profileHash===profileHash||!f.profileHash&&profile.version===0);const feedbackAdjustment=useFeedback&&current?(f!.helpful?5:-10):0;if(feedbackAdjustment)reasons.push('当前范围使用反馈调整 '+(feedbackAdjustment>0?'+':'')+feedbackAdjustment+' 分');
   return[{eligible,item,profile,profileHash,score:baseScore+feedbackAdjustment,baseScore,feedbackAdjustment,reasons,differences,...(f?{feedback:{helpful:f.helpful,reason:f.reason,current}}:{})}];
  }).sort((a,b)=>b.score-a.score||b.item.createdAt.localeCompare(a.item.createdAt)||a.item.id.localeCompare(b.item.id));
 }
 snapshot(id:string){const s=this.all<MorningSnapshot>('morning').find(s=>s.id===id);if(!s)throw Error('晨会快照不存在或已不在最近记录内');return s;}
 briefs(snapshotId?:string){for(const b of this.all<MorningBrief>('brief'))if(b.status==='pending'&&Date.parse(b.deadlineAt)<=Date.now())this.saveBrief({...b,status:'failed',error:'摘要超时或应用已退出，请重新生成。',version:b.version+1,updatedAt:new Date().toISOString()});return this.all<MorningBrief>('brief',snapshotId);}
 brief(id:string){const b=this.briefs().find(b=>b.id===id);if(!b)throw Error('摘要不存在');return b;}
 saveBrief(b:MorningBrief){this.put('brief',b.id,b.snapshotId,b);this.put('brief_version',b.id+':'+b.version,b.id,b);}
 complete(id:string,snapshotHash:string,output:unknown,model:string|null,error:string|null){const b=this.brief(id);if(b.status!=='pending')return b;if(b.snapshotHash!==snapshotHash)throw Error('摘要上下文不一致');const s=this.snapshot(b.snapshotId);if(s.fingerprint!==snapshotHash)throw Error('晨会快照不一致');
  let parsed:zBrief|undefined;try{if(!error){parsed=BriefOutput.parse(output);const keys=new Set(s.items.slice(0,20).map(i=>i.key));if(parsed.citations.some(k=>!keys.has(k)))throw Error('摘要引用不属于冻结晨会');}}catch{error='摘要格式或引用不符合要求，请重试。';}
  const next:MorningBrief={...b,status:error?'failed':'completed',body:parsed&&!error?parsed.body:'',originalBody:parsed&&!error?parsed.body:'',citations:parsed&&!error?parsed.citations:[],model:model?.slice(0,200)??null,error:error?'摘要未完成，请检查模型配置后重新生成。':null,version:b.version+1,updatedAt:new Date().toISOString()};this.saveBrief(next);return next;
 }
}
type zBrief={body:string;citations:string[]};
export function anomalyOf(e:BusinessEvidence):keyof typeof anomalyNames|null{return e.status==='needs_evidence'?'needs_evidence':e.status==='low_margin'?'low_margin':e.status==='warning'?('kind'in e&&e.kind==='inventory'?'inventory_warning':'ads_warning'):null;}
