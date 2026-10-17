import { beforeEach,afterEach,test,expect } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RetailStore} from './store';import {DEMO_CSV,calculate} from './operations';import type {EvidenceRecord} from './operations';
import {simulate,readTool,MarginModelReportSchema} from './investigations';import type {Trace} from './investigations';
import {auditMarginNumbers,numericObservations} from './margin-numeric';
let dir:string,store:RetailStore,record:EvidenceRecord;
const names=['retail_get_data_health','retail_get_sku_context','retail_get_promotions','retail_simulate_actions'] as const;
const traces=(r:EvidenceRecord):Trace[]=>names.map(tool=>({at:new Date().toISOString(),stage:'investigate',tool,evidenceId:`${r.id}:${tool}`,data:readTool(r,tool)}));
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'merqo-numeric-'));store=new RetailStore(join(dir,'data.sqlite'));store.import(DEMO_CSV,undefined,'demo');record=store.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;});
afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
test('numeric audit separates unit, total and coupon delta with exact frozen citations',()=>{
 const audit=auditMarginNumbers(record,simulate(record),traces(record));const facts=Object.fromEntries(audit.facts.map(f=>[f.key,f]));
 expect(audit.calculationFieldsComplete).toBe(true);expect(facts.unitRevenue?.value).toBe(7000);expect(facts.unitProfit?.value).toBe(1000);expect(facts.totalRevenue?.value).toBe(280000);expect(facts.totalProfit?.value).toBe(40000);expect(facts.margin?.value).toBe(1429);expect(facts.quantity?.value).toBe(40);expect(facts.couponReduction?.value).toBe(500);expect(facts.proposedCoupon?.value).toBe(1500);expect(facts.proposedMargin?.value).toBe(2000);
 expect(facts.unitProfit?.grain).toBe('per_sales_unit');expect(facts.totalProfit?.grain).toBe('snapshot_total');expect(facts.couponReduction?.evidenceIds).toEqual([`${record.id}:retail_get_promotions`,`${record.id}:retail_simulate_actions`]);
 const observations=numericObservations(audit);expect(observations).toHaveLength(5);expect(observations[2]?.text).toContain('商家券减少额：¥5.00');expect(observations[1]?.text).toContain('合计商品毛利：¥400.00');
});
test('contradictory money, unit, quantity, threshold and computed action are refused',()=>{
 const patches:Array<(trace:Trace[])=>void>=[
  t=>{(t[1]!.data as {calculation:{totalProfitMinor:number}}).calculation.totalProfitMinor=400000;},t=>{(t[1]!.data as {calculationGrain:{money:string}}).calculationGrain.money='USD cents';},t=>{(t[1]!.data as {soldQty:number}).soldQty=41;},t=>{(t[2]!.data as {couponMinor:number}).couponMinor=1500;},t=>{(t[0]!.data as {marginThreshold:{bps:number}}).marginThreshold.bps=2001;},t=>{(t[0]!.data as {importedAt:string}).importedAt='2999-01-01T00:00:00Z';},t=>{(t[3]!.data as Array<{couponMinor:number}>)[1]!.couponMinor=1300;}
 ];
 for(const patch of patches){const trace=structuredClone(traces(record));patch(trace);expect(()=>auditMarginNumbers(record,simulate(record),trace)).toThrow('不一致');}
});
test('missing, duplicate and cross-record citations never receive numeric audit',()=>{
 const input=traces(record);expect(()=>auditMarginNumbers(record,simulate(record),input.slice(1))).toThrow('引用');expect(()=>auditMarginNumbers(record,simulate(record),[...input,input[0]!])).toThrow('引用');const foreign=structuredClone(input);foreign[2]!.evidenceId='foreign:retail_get_promotions';expect(()=>auditMarginNumbers(record,simulate(record),foreign)).toThrow('引用');
});
test('unknown values remain null, zero totals remain zero and negative margin is retained',()=>{
 for(const row of [{...record.row,cost_minor:null},{...record.row,sold_qty:0},{...record.row,cost_minor:8000}]){
  const r={...record,row,calculation:calculate(row)};const audit=auditMarginNumbers(r,simulate(r),traces(r));const byKey=Object.fromEntries(audit.facts.map(f=>[f.key,f.value]));
  if(row.cost_minor===null){expect(audit.calculationFieldsComplete).toBe(false);expect(byKey.unitProfit).toBeNull();expect(byKey.totalProfit).toBeNull();expect(numericObservations(audit)[0]?.text).toContain('待补证');}
  else if(row.sold_qty===0){expect(byKey.totalRevenue).toBe(0);expect(byKey.unitRevenue).toBe(7000);}
  else{expect(byKey.unitProfit).toBe(-1000);expect(byKey.margin).toBe(-1429);}
 }
});
test('model prose cannot smuggle digits or business numerals outside code facts',()=>{
 const base={summary:'优惠叠加需要核验',observations:[],hypotheses:[],unknowns:['缺需求弹性'],alternatives:['成本口径也可能影响结论'],options:[{kind:'observe',rationale:'继续核验'},{kind:'reduce_coupon',rationale:'条件方案，不保证收益'}]};
 expect(MarginModelReportSchema.safeParse(base).success).toBe(true);
 for(const value of ['商家券减少200分','单件毛利１０００分','毛利五元','券降至一千五百分'])expect(MarginModelReportSchema.safeParse({...base,summary:value}).success).toBe(false);
 for(const key of ['unknowns','alternatives'] as const)expect(MarginModelReportSchema.safeParse({...base,[key]:['预计收益20%']}).success).toBe(false);
 expect(MarginModelReportSchema.safeParse({...base,hypotheses:[{text:'优惠占30%',evidenceIds:['frozen:retail_get_promotions']}]}).success).toBe(false);
});
