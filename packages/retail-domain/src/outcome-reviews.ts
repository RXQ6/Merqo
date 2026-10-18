import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { offerScope } from './offers';
import { bundleIdentity, giftIdentity, membershipIdentity, calculate, previewCsv } from './operations';
import type { EvidenceRecord, RetailRow } from './operations';
import { calculateSignal, previewSignals, shiftDate } from './signals';
import type { SignalRecord, SignalRow } from './signals';
import { SimulationLedger } from './simulation';
import type { ExecutionJob, ExecutionReceipt } from './simulation';

type Evidence = EvidenceRecord | SignalRecord;
type Row = RetailRow | SignalRow;
interface JsonRow { json: string }
export const reviewDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ReviewMetric { key: string; label: string; unit: 'minor' | 'number' | 'bps'; before: number | null; after: number | null; delta: number | null }
export interface ReviewObservation { origin: 'builtin_synthetic' | 'uploaded_simulation'; row: Row; hash: string; importedAt: string }
export interface OutcomeReview {
  id: string; workspaceId: string; investigationId: string; job: ExecutionJob; receipt: ExecutionReceipt; baseline: Evidence;
  version: number; createdAt: string; updatedAt: string; windowStart: string; windowEnd: string; windowDays: number;
  clockBasis: 'synthetic_business_date'; observation: ReviewObservation | null;
  final: { at: string; actor: 'local-simulation-reviewer'; conclusion: 'comparison_only' | 'inconclusive'; note: string; confounders: string; observationHash: string } | null;
}
export interface CaseMemory { offerScope?: string | null; membershipIdentity?: string | null; giftIdentity?: string | null; bundleIdentity?: string | null; id: string; reviewId: string; workspaceId: string; scenario: ExecutionJob['scenario']; shop: string; channel: string; sku: string; warehouse: string | null; campaign: string | null; spec: string | null; windowEnd: string; reviewedAt: string; source: 'synthetic'; summary: string; confounders: string; conclusion: 'comparison_only' | 'inconclusive'; metrics: ReviewMetric[]; refs: { runId: string; jobId: string; approvalId: string; receiptId: string; evidenceHash: string; observationHash: string }; warning: string }
export interface ReviewView { review: OutcomeReview; state: 'awaiting_window' | 'needs_evidence' | 'ready' | 'reviewed'; blockers: string[]; metrics: ReviewMetric[]; history: OutcomeReview[]; case: CaseMemory | null; compensations: {id:string;receiptId:string|null}[] }
export interface ObservationPreview { row: Row; origin: 'uploaded_simulation'; hash: string; blockers: string[]; metrics: ReviewMetric[] }
const today = (): string => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const spec = (e: Evidence): string | null => 'spec' in e.row ? e.row.spec : null;

export function installReviewSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS outcome_reviews(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS outcome_reviews_recent ON outcome_reviews(workspace_id,json_extract(json,'$.updatedAt'));
    CREATE TABLE IF NOT EXISTS outcome_review_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS retail_cases(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,shop TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL,scenario TEXT NOT NULL,window_end TEXT NOT NULL,reviewed_at TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS retail_cases_scope ON retail_cases(workspace_id,shop,channel,sku,scenario,window_end DESC,reviewed_at DESC);`);
}

/** Called inside the owning store's IMMEDIATE transaction. No source or simulated target writes. */
export class ReviewLedger {
  constructor(private db: Database, private workspaceId: string) {}
  private raw(id: string): OutcomeReview {
    const row = this.db.query<JsonRow, [string,string]>('SELECT json FROM outcome_reviews WHERE id=? AND workspace_id=?').get(id,this.workspaceId);
    if (!row) throw new Error('复盘不存在或不属于当前工作空间');
    return JSON.parse(row.json) as OutcomeReview;
  }
  private save(r: OutcomeReview): void {
    this.db.query('INSERT INTO outcome_reviews VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(r.id,r.job.id,this.workspaceId,JSON.stringify(r));
    this.db.query('INSERT INTO outcome_review_versions VALUES(?,?,?)').run(r.id,r.version,JSON.stringify(r));
  }
  create(jobId: string): ReviewView {
    const v = new SimulationLedger(this.db,this.workspaceId).view(jobId);
    if (!v.receipt || v.job.scope.source !== 'demo') throw new Error('仅成功的演示模拟执行可创建合成复盘');
    const existing = this.db.query<{id:string},[string]>('SELECT id FROM outcome_reviews WHERE job_id=?').get(jobId);
    if (existing) return this.view(existing.id);
    const decision = this.db.query<JsonRow,[string,number]>('SELECT json FROM decision_versions WHERE id=? AND version=?').get(v.job.decisionId,v.job.decisionVersion);
    if (!decision) throw new Error('原决策版本不存在');
    const investigationId = (JSON.parse(decision.json) as {investigationId:string}).investigationId;
    const stored = this.db.query<JsonRow,[string]>('SELECT json FROM investigations WHERE id=?').get(investigationId);
    if (!stored) throw new Error('原调查不存在');
    const run = JSON.parse(stored.json) as {id:string;evidence:Evidence;report:unknown}; const e = run.evidence;
    if (run.id!==investigationId || reviewDigest(run.report)!==v.job.reportHash || e.source!=='demo' || e.row.shop_id!==v.job.scope.shop || e.row.channel!==v.job.scope.channel || e.row.sku_id!==v.job.scope.sku || e.row.date!==v.job.scope.date || ('hash' in e ? e.hash : e.snapshotHash) !== v.job.evidenceHash || v.receipt.jobId !== v.job.id || v.receipt.actionHash !== v.job.actionHash || v.receipt.resolutionId !== v.job.resolutionId || v.receipt.requestId!==v.job.requestId || v.receipt.decisionVersion!==v.job.decisionVersion || v.receipt.evidenceHash!==v.job.evidenceHash || v.receipt.reportHash!==v.job.reportHash) throw new Error('原执行与冻结证据绑定不符');
    const days = 'window_days' in e.row ? e.row.window_days : 1;
    if (days === null || days < 1 || days > 90) throw new Error('原观察窗口不完整');
    const at = new Date().toISOString();
    const r: OutcomeReview = {id:randomUUID(),workspaceId:this.workspaceId,investigationId,job:v.job,receipt:v.receipt,baseline:e,version:1,createdAt:at,updatedAt:at,clockBasis:'synthetic_business_date',windowStart:shiftDate(e.row.date,1),windowEnd:shiftDate(e.row.date,days),windowDays:days,observation:null,final:null};
    this.save(r); return this.view(r.id);
  }
  private compare(r: OutcomeReview, row: Row | null): { blockers: string[]; metrics: ReviewMetric[] } {
    const blockers: string[] = []; const metrics: ReviewMetric[] = [];
    if (!row) return {blockers:['缺少观察窗口的合成记录，请载入回放或预览上传CSV'],metrics};
    const b = r.baseline.row;
    if (row.shop_id !== b.shop_id || row.channel !== b.channel || row.sku_id !== b.sku_id || row.date !== r.windowEnd) blockers.push('观察记录的店铺、渠道、SKU或结束日期不匹配');
    if (('spec' in b && (!('spec' in row) || row.spec !== b.spec)) || ('currency' in b && (!('currency' in row) || row.currency !== b.currency))) blockers.push('商品规格或币种不一致');
    const add = (key:string,label:string,unit:ReviewMetric['unit'],before:number|null,after:number|null) => metrics.push({key,label,unit,before,after,delta:before===null||after===null?null:after-before});
    if (r.job.scenario === 'margin') {
      if (!('list_price_minor' in row) || !('list_price_minor' in b)) return {blockers:[...blockers,'观察记录不是日毛利口径'],metrics};
      if (bundleIdentity(row) !== bundleIdentity(b)) blockers.push('组合装子项映射与原快照不一致');
      if (membershipIdentity(row) !== membershipIdentity(b)) blockers.push('会员分组、身份或叠加规则与原快照不一致');
      if (offerScope(row) !== offerScope(b)) blockers.push('参考报价上下文与原快照不一致，不能静默移除');
      if (giftIdentity(row) !== giftIdentity(b)) blockers.push('赠品关联、数量或口径与原快照不一致');
      const x = calculate(b), y = calculate(row); blockers.push(...x.issues,...y.issues);
      add('revenue','商品收入 / 件','minor',x.revenueMinor,y.revenueMinor);add('profit','商品毛利 / 件','minor',x.profitMinor,y.profitMinor);add('margin','毛利率','bps',x.marginBps,y.marginBps);add('sales','净成交件数','number',b.sold_qty,row.sold_qty);
    } else {
      if (!('window_days' in row) || !('window_days' in b)) return {blockers:[...blockers,'观察记录不是窗口口径'],metrics};
      if (row.window_days !== r.windowDays || row.baseline_window_days !== r.windowDays || row.baseline_end_date !== b.date) blockers.push('必须为紧邻、等长窗口，且对照窗结束日期对应原快照');
      const x = calculateSignal(r.job.scenario,b), y = calculateSignal(r.job.scenario,row);blockers.push(...x.issues,...y.issues);
      if (r.job.scenario === 'inventory') {
        if (!('warehouse_id' in b) || !('warehouse_id' in row)) return {blockers:[...blockers,'观察记录不是库存口径'],metrics};
        if (row.warehouse_id !== b.warehouse_id || row.baseline_sales_qty !== b.recent_sales_qty) blockers.push('仓库或原窗口销量对照值不一致');
        add('sales','窗口净销量','number',b.recent_sales_qty,row.recent_sales_qty);add('available','即时可售件数','number',x.available,y.available);add('coverage','库存覆盖天数','number',x.coverageDays,y.coverageDays);
      } else {
        if (!('campaign_id' in b) || !('campaign_id' in row)) return {blockers:[...blockers,'观察记录不是广告口径'],metrics};
        if (row.campaign_id !== b.campaign_id || row.attribution_window !== b.attribution_window || row.baseline_attribution_window !== b.attribution_window || row.baseline_spend_minor !== b.spend_minor || row.baseline_revenue_minor !== b.attributed_revenue_minor || row.baseline_clicks !== b.clicks || row.baseline_conversions !== b.conversions) blockers.push('Campaign、归因口径或原窗口对照值不一致');
        add('spend','窗口广告花费','minor',b.spend_minor,row.spend_minor);add('revenue','窗口归因收入','minor',b.attributed_revenue_minor,row.attributed_revenue_minor);add('roas','ROAS','number',x.roas,y.roas);add('conversion','点击转化率','bps',x.conversionBps,y.conversionBps);
      }
    }
    return {blockers:[...new Set(blockers)],metrics};
  }
  view(id: string): ReviewView {
    const review = this.raw(id); const compared = this.compare(review,review.observation?.row??null);
    const blockers = [...compared.blockers];if (review.windowEnd >= today()) blockers.unshift('观察窗口尚未结束，请在Asia/Shanghai窗口结束后刷新');
    const c = this.db.query<JsonRow,[string]>('SELECT json FROM retail_cases WHERE review_id=?').get(id);
    const compensations=this.db.query<{id:string;receipt_id:string|null},[string]>(`SELECT h.id,json_extract(c.json,'$.localRequestId') AS receipt_id FROM compensation_heads h LEFT JOIN compensation_receipts c ON c.id=h.id WHERE h.source_job_id=?`).all(review.job.id).map(c=>({id:c.id,receiptId:c.receipt_id}));
    return {compensations,review,state:review.final?'reviewed':review.windowEnd>=today()?'awaiting_window':blockers.length?'needs_evidence':'ready',blockers,metrics:compared.metrics,history:this.db.query<JsonRow,[string]>('SELECT json FROM outcome_review_versions WHERE id=? ORDER BY version DESC LIMIT 30').all(id).map(v=>JSON.parse(v.json) as OutcomeReview),case:c?JSON.parse(c.json) as CaseMemory:null};
  }
  list(): ReviewView[] {return this.db.query<{id:string},[string]>('SELECT id FROM outcome_reviews WHERE workspace_id=? ORDER BY json_extract(json,\'$.updatedAt\') DESC,id DESC LIMIT 50').all(this.workspaceId).map(r=>this.view(r.id));}
  preview(id:string,csv:string):ObservationPreview {
    const r=this.raw(id);const p=r.job.scenario==='margin'?previewCsv(csv):previewSignals(r.job.scenario,csv);
    if(p.valid.length!==1||p.rejected.length||p.total!==1)throw new Error('观察CSV须恰好一条有效记录，不能包含错误、重复或其他范围行');
    const row=p.valid[0]!;return {row,origin:'uploaded_simulation',hash:reviewDigest(row),...this.compare(r,row)};
  }
  observe(id:string,version:number,input:{csv:string;hash:string}|null):ReviewView {
    const r=this.raw(id);let row:Row;let origin:ReviewObservation['origin'];
    if(input){const p=this.preview(id,input.csv);if(p.hash!==input.hash)throw new Error('预览摘要已变化，请重新预览');row=p.row;origin='uploaded_simulation';}
    else {row=this.demo(r);origin='builtin_synthetic';}
    const hash=reviewDigest({row,origin});if(r.observation?.hash===hash)return this.view(id);
    if(r.final)throw new Error('已复核Case不可覆盖');if(r.version!==version)throw new Error('复盘版本已变化，请刷新');
    const compared=this.compare(r,row);if(compared.blockers.some(b=>/不匹配|不一致|不是|必须/.test(b)))throw new Error(compared.blockers.join('；'));
    const now=new Date().toISOString();r.observation={row,origin,hash,importedAt:now};r.version++;r.updatedAt=now;this.save(r);return this.view(id);
  }
  private demo(r:OutcomeReview):Row {
    const row=structuredClone(r.baseline.row);row.date=r.windowEnd;
    if ('list_price_minor' in row) for (const offer of row.offers ?? []) {
      if (offer.observed_on === r.baseline.row.date) offer.observed_on = r.windowEnd;
    }
    if('window_days' in row){row.baseline_end_date=r.baseline.row.date;row.baseline_window_days=r.windowDays;if('warehouse_id' in row){row.baseline_sales_qty=row.recent_sales_qty;if(row.inbound_eta)row.inbound_eta=shiftDate(row.inbound_eta,r.windowDays);}else{row.baseline_spend_minor=row.spend_minor;row.baseline_revenue_minor=row.attributed_revenue_minor;row.baseline_clicks=row.clicks;row.baseline_conversions=row.conversions;row.baseline_attribution_window=row.attribution_window;}}
    // Deliberately unchanged business outcomes: a successful simulated write is not measured uplift.
    return row;
  }
  finalize(id:string,version:number,hash:string,conclusion:'comparison_only'|'inconclusive',note:string,confounders:string,actor:string):ReviewView {
    if(actor!=='local-simulation-reviewer')throw new Error('缺少本地模拟复核角色');
    const view=this.view(id);const r=view.review;note=note.trim();confounders=confounders.trim();if(!note||note.length>2000||!confounders||confounders.length>2000)throw new Error('请填写复盘结论和同期活动/干扰因素，各1至2000字');
    if(r.final){if(r.final.observationHash===hash&&r.final.conclusion===conclusion&&r.final.note===note&&r.final.confounders===confounders&&r.version===version+1)return view;throw new Error('已复核Case不可覆盖');}
    if(r.version!==version||r.observation?.hash!==hash)throw new Error('复盘版本或观察摘要已变化，请刷新');
    if(view.state==='awaiting_window'||!r.observation)throw new Error('观察窗口未结束或缺少观察记录');
    if(view.blockers.length&&conclusion!=='inconclusive')throw new Error('证据不完整，只能保存无法判断的Case');
    const at=new Date().toISOString();r.final={at,actor,conclusion,note,confounders,observationHash:hash};r.version++;r.updatedAt=at;this.save(r);
    const c:CaseMemory={id:randomUUID(),reviewId:r.id,workspaceId:this.workspaceId,scenario:r.job.scenario,shop:r.job.scope.shop,channel:r.job.scope.channel,sku:r.job.scope.sku,warehouse:r.job.scope.warehouse,campaign:r.job.scope.campaign,spec:spec(r.baseline),windowEnd:r.windowEnd,reviewedAt:at,source:'synthetic',summary:note,confounders,conclusion,metrics:view.metrics,refs:{runId:r.investigationId,jobId:r.job.id,approvalId:r.job.resolutionId,receiptId:r.receipt.id,evidenceHash:r.job.evidenceHash,observationHash:hash},offerScope:'list_price_minor' in r.observation!.row?offerScope(r.observation!.row):null,membershipIdentity:'list_price_minor' in r.observation!.row?membershipIdentity(r.observation!.row):null,giftIdentity:'list_price_minor' in r.observation!.row?giftIdentity(r.observation!.row):null,bundleIdentity:'list_price_minor' in r.observation!.row?bundleIdentity(r.observation!.row):null,warning:'合成业务时间回放；人工复核只确认比较记录，不证明动作因果或真实经营收益，不授予批准或执行权限'};
    this.db.query('INSERT INTO retail_cases VALUES(?,?,?,?,?,?,?,?,?,?)').run(c.id,c.reviewId,this.workspaceId,c.shop,c.channel,c.sku,c.scenario,c.windowEnd,c.reviewedAt,JSON.stringify(c));return this.view(id);
  }
  search(e:Evidence,scenario:ExecutionJob['scenario'],asOf:string):CaseMemory[]{
    if(e.source!=='demo')return [];
    const row=e.row;return this.db.query<JsonRow,[string,string,string,string,string,string,string,string|null,string|null,string|null,string|null,string|null,string|null,string|null]>(`SELECT json FROM retail_cases WHERE workspace_id=? AND shop=? AND channel=? AND sku=? AND scenario=? AND window_end<=? AND reviewed_at<=? AND json_extract(json,'$.spec') IS ? AND json_extract(json,'$.warehouse') IS ? AND json_extract(json,'$.campaign') IS ? AND json_extract(json,'$.bundleIdentity') IS ? AND json_extract(json,'$.giftIdentity') IS ? AND json_extract(json,'$.membershipIdentity') IS ? AND json_extract(json,'$.offerScope') IS ? ORDER BY window_end DESC,reviewed_at DESC,id DESC LIMIT 5`).all(this.workspaceId,row.shop_id,row.channel,row.sku_id,scenario,row.date,asOf,spec(e),'warehouse_id' in row?row.warehouse_id:null,'campaign_id' in row?row.campaign_id:null,'list_price_minor' in row?bundleIdentity(row):null,'list_price_minor' in row?giftIdentity(row):null,'list_price_minor' in row?membershipIdentity(row):null,'list_price_minor' in row?offerScope(row):null).map(r=>JSON.parse(r.json) as CaseMemory);
  }
}
