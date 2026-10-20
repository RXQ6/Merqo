/** Synthetic events and independently declared control totals. Never used for live mapping defaults. */
export function ingestionFixture(qualityErrors=false):Record<string,unknown>[] {
 const rows=Array.from({length:7},(_,i)=>{
  const order_at=`2026-10-14T10:${String(i).padStart(2,'0')}:00+08:00`;
  const base={order_id:`D-${i+1}`,line_id:'L1',shop_id:'DEMO-SHOP',channel:'抖店演练',sku_id:'DEMO-SKU',spec:'单件',currency:'CNY',order_at,quantity:1,allocated_discount_minor:0,platform_subsidy_minor:0};
  const events=[{...base,event_id:`D-${i+1}-ordered`,kind:'ordered',event_at:order_at,amount_minor:10000},{...base,event_id:`D-${i+1}-paid`,kind:'paid',event_at:`2026-10-14T11:${String(i).padStart(2,'0')}:00+08:00`,amount_minor:10000},{...base,event_id:`D-${i+1}-shipped`,kind:'shipped',event_at:`2026-10-14T12:${String(i).padStart(2,'0')}:00+08:00`,amount_minor:0}];
  if(i===6)events.push({...base,event_id:'D-7-refunded',kind:'refunded',event_at:'2026-10-16T10:00:00+08:00',amount_minor:10000});
  return{synthetic:true,fixture_order_id:`DEMO-${i+1}`,events};
 });
 if(qualityErrors){(rows[2]!.events[1]! as Record<string,unknown>).amount_minor='12.345';rows[3]!.events[0]!.sku_id='';}
 return rows;
}
export const fixtureControlTotals={eventCount:22,orderedQty:7,paidQty:7,refundedQty:1,paidMinor:70000,refundedMinor:10000,discountMinor:0,subsidyMinor:0};
