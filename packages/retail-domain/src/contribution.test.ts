import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {TransactionStore} from './transaction-store';import {decodeTransactionCsv,TRANSACTION_DEMO,type TransactionQuery} from './transactions';
import {COST_CATEGORIES,COST_FIELDS,parseCosts,calculateContribution,type CostRow} from './contribution';
const base={source_id:'demo-transactions',shop_id:'demo-nanfeng',channel:'线上商城',order_id:'O1',line_id:'L1',currency:'CNY' as const,observed_at:new Date().toISOString()};
const rows:CostRow[]=COST_CATEGORIES.map((category,i)=>({...base,category,amount_minor:[6000,1000,500,500,0][i]!}));
const csv=(list=rows)=>COST_FIELDS.join(',')+'\n'+list.map(r=>COST_FIELDS.map(f=>JSON.stringify(String(r[f]))).join(',')).join('\n');
const query:TransactionQuery={source:'demo',basis:'order',startDate:'2026-10-14',endDate:'2026-10-14',shop:'',channel:'',offset:0,limit:30};
test('refunds and five explicitly supplied net costs produce declared contribution, never infer cost recovery',()=>{
 const result=calculateContribution(decodeTransactionCsv(TRANSACTION_DEMO).events,rows);expect(result.totals).toMatchObject({paidMinor:17000,refundedMinor:8500,retainedMinor:8500,costMinor:8000,contributionMinor:500});expect(result.readyLines).toBe(1);
 const missing=calculateContribution(decodeTransactionCsv(TRANSACTION_DEMO).events,rows.slice(0,4));expect(missing.totals.contributionMinor).toBeNull();expect(missing.lines[0]?.costs.other).toBeNull();
 const stale=calculateContribution(decodeTransactionCsv(TRANSACTION_DEMO).events,rows.map(r=>({...r,observed_at:'2026-10-14T12:00:00+08:00'})));expect(stale.needsEvidenceLines).toBe(1);expect(stale.lines[0]?.costMinor).toBeNull();
});
test('explicit duplicate costs dedupe; conflicting categories, decimal amounts, future observations and outside entities reject',()=>{
 expect(parseCosts(csv([...rows,rows[0]!])).duplicates).toBe(1);expect(()=>parseCosts(csv([...rows,{...rows[0]!,amount_minor:1}]))).toThrow('冲突');expect(()=>parseCosts(csv([{...rows[0]!,amount_minor:0.1}]))).toThrow('无效');expect(()=>parseCosts(csv([{...rows[0]!,observed_at:'2099-01-01T00:00:00Z'}]))).toThrow('超前');expect(()=>calculateContribution(decodeTransactionCsv(TRANSACTION_DEMO).events,[{...rows[0]!,source_id:'other-source'}])).toThrow('范围之外');
});
test('cost reports freeze full cohort rather than current page, persist across restart and do not change transaction events',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-contribution-')),file=join(dir,'ledger.sqlite'),s=new TransactionStore(file);let second:TransactionStore|undefined;try{s.demo();const before=s.stateHash('demo'),r=s.contribution({label:'独立费用样本',query:{...query,limit:1},csv:csv()})[0]!;expect(r.totals.contributionMinor).toBe(500);expect(r.authority).toBe('operator_declared');expect(s.stateHash('demo')).toBe(before);second=new TransactionStore(file);expect(second.contributionReports()[0]?.id).toBe(r.id);expect(()=>s.contribution({label:'错误时间归属',query:{...query,basis:'event'},csv:csv()})).toThrow('原订单');
 }finally{second?.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
