import {test,expect} from 'bun:test';
import {allocateOrders,allocateOrderCsv,allocationCsv,ALLOCATION_DEMO} from './order-allocation';
import type {AllocationInput} from './order-allocation';
const row=(line_id:string,gross_minor=100):AllocationInput=>({order_id:'O',line_id,gross_minor,eligible:true,order_discount_minor:1,order_subsidy_minor:2});

test('integer largest remainders conserve each pool, use stable line IDs, exclude gifts and ignore input ordering',()=>{
 const input=[row('B'),row('A'),{...row('gift',0),eligible:false}];
 const actual=allocateOrders(input);expect(actual).toEqual(allocateOrders([...input].reverse()));
 expect(actual.map(r=>[r.line_id,r.allocated_discount_minor,r.platform_subsidy_minor,r.settlement_minor])).toEqual([['A',1,1,100],['B',0,1,101],['gift',0,0,0]]);
 expect(allocateOrderCsv(ALLOCATION_DEMO).reduce((n,r)=>n+r.settlement_minor,0)).toBe(201);
 for(let total=0;total<151;total++){
  const result=allocateOrders([1,2,3,4,5].map((n)=>({...row(String(n),n*10),order_discount_minor:total,order_subsidy_minor:total})));
  expect(result.reduce((n,r)=>n+r.allocated_discount_minor,0)).toBe(total);
  expect(result.reduce((n,r)=>n+r.platform_subsidy_minor,0)).toBe(total);
  expect(result.every(r=>r.allocated_discount_minor<=r.gross_minor&&Number.isInteger(r.settlement_minor))).toBe(true);
 }
});
test('BigInt multiplication handles large orders without losing fen and separate orders never share discounts',()=>{
 const input=Array.from({length:1000},(_,i)=>({...row(String(i),100000000-i),order_discount_minor:99999999,order_subsidy_minor:100000000}));
 const result=allocateOrders(input);expect(result.reduce((n,r)=>n+r.allocated_discount_minor,0)).toBe(99999999);expect(result.reduce((n,r)=>n+r.platform_subsidy_minor,0)).toBe(100000000);
 expect(allocateOrders([row('A'),{...row('A'),order_id:'other',order_discount_minor:0}]).map(r=>r.allocated_discount_minor)).toEqual([1,0]);
});
test('duplicate lines, conflicting pools, invalid currency assumptions or impossible allocation reject the whole input',()=>{
 for(const input of [[],[row('A'),row('A')],[row('A'),{...row('B'),order_discount_minor:2}],[{...row('A'),eligible:false}],[row('A',0)],[{...row('A'),gross_minor:0.1}],[{...row('A'),order_discount_minor:101}],[{...row('A'),currency:'USD'}]])expect(()=>allocateOrders(input)).toThrow();
 for(const csv of [ALLOCATION_DEMO.replace('true','unknown'),ALLOCATION_DEMO.replace('100,true','1.5,true'),ALLOCATION_DEMO.replace('gross_minor','currency')])expect(()=>allocateOrderCsv(csv)).toThrow();
 expect(allocationCsv(allocateOrders([{...row('=cmd'),order_id:'@bad'}]))).toContain('"\'=cmd"');
});
