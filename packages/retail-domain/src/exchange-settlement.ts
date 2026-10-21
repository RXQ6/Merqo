import {z} from 'zod';
import {transactionEntity,exchangeTarget,TRANSACTION_FIELDS,TRANSACTION_OPTIONAL_FIELDS,type TransactionEvent} from './transactions';
const id=z.string().trim().min(1).max(128),money=z.number().int().min(0).max(10000000000);
export const ExchangeInputSchema=z.strictObject({source:z.enum(['demo','csv']),sourceId:id,shop:id,channel:z.string().max(200),orderId:id,lineId:id,label:z.string().trim().min(1).max(100),strategy:z.enum(['refund_repurchase','difference']),oldCreditMinor:money,newSettlementMinor:money,observedAt:z.string().datetime({offset:true}),note:z.string().trim().min(10).max(500)});
export type ExchangeInput=z.infer<typeof ExchangeInputSchema>;
export interface ExchangeCalculation {
 status:'matched'|'pending'|'mismatch'|'needs_evidence';reasons:string[];
 oldOrderId:string|null;oldLineId:string|null;quantity:number|null;
 amounts:null|{oldPaid:number;newPaid:number;oldRefund:number;expectedNewCash:number;expectedOldRefund:number;expectedDifference:number;actualDifference:number;outstandingPay:number;outstandingRefund:number;combinedCash:number;targetCombinedCash:number};
}
export interface ExchangeReport extends ExchangeCalculation {id:string;at:number;input:ExchangeInput;authority:'operator_declared';ledgerHash:string;events:TransactionEvent[];}
export const ExchangePublicSchemas=[z.strictObject({op:z.literal('exchange_reports')}),z.strictObject({op:z.literal('exchange_analyze'),input:ExchangeInputSchema})] as const;
export function calculateExchange(input:ExchangeInput,events:TransactionEvent[]):ExchangeCalculation {
 const key=JSON.stringify([input.sourceId,input.shop,input.channel,input.orderId,input.lineId]),next=events.filter(e=>transactionEntity(e)===key),newOrder=next.find(e=>e.kind==='ordered'),target=newOrder&&exchangeTarget(newOrder),old=target?events.filter(e=>transactionEntity(e)===target):[],oldOrder=old.find(e=>e.kind==='ordered');
 const reasons:string[]=[],empty={oldOrderId:oldOrder?.order_id??null,oldLineId:oldOrder?.line_id??null,quantity:newOrder?.quantity??null};
 const sum=(list:TransactionEvent[],kind:TransactionEvent['kind'],field:'quantity'|'amount_minor')=>list.filter(e=>e.kind===kind).reduce((n,e)=>n+e[field],0);
 if(!newOrder||!target||!oldOrder)reasons.push('缺少明确换货关联的新旧订单行');
 if(oldOrder&&newOrder){
  if(oldOrder.quantity!==newOrder.quantity||sum(old,'returned','quantity')!==oldOrder.quantity||sum(old,'paid','quantity')!==oldOrder.quantity)reasons.push('当前只核对原行全额结清、整行实物退回且等件数单一换货；部分换货或未结清须补专用口径');
  if(events.filter(e=>e.kind==='ordered'&&exchangeTarget(e)===target).length!==1)reasons.push('原行对应多个换货分支，不能重复使用原款额度');
  if(sum(old,'cancelled','quantity')||sum(next,'cancelled','quantity')||sum(next,'refunded','amount_minor')||sum(next,'refunded','quantity')||sum(next,'returned','quantity'))reasons.push('取消、新单退款或再次退回需要单独的后续结算口径');
  if(input.oldCreditMinor>sum(old,'paid','amount_minor'))reasons.push('声明可抵退原款超过原行已收结算金额');
 }
 const relevant=[...old,...next];if(relevant.some(e=>Date.parse(e.event_at)>Date.parse(input.observedAt)))reasons.push('声明核对时间早于已知交易事件，请重新核对协议及后续流水');
 if(reasons.length)return{...empty,status:'needs_evidence',reasons,amounts:null};
 const oldPaid=sum(old,'paid','amount_minor'),newPaid=sum(next,'paid','amount_minor'),oldRefund=sum(old,'refunded','amount_minor'),expectedDifference=input.newSettlementMinor-input.oldCreditMinor;
 const expectedNewCash=input.strategy==='refund_repurchase'?input.newSettlementMinor:Math.max(expectedDifference,0),expectedOldRefund=input.strategy==='refund_repurchase'?input.oldCreditMinor:Math.max(-expectedDifference,0),outstandingPay=expectedNewCash-newPaid,outstandingRefund=expectedOldRefund-oldRefund;
 const status=outstandingPay<0||outstandingRefund<0?'mismatch':outstandingPay||outstandingRefund?'pending':'matched';
 reasons.push(status==='matched'?'已导入资金流与人工声明的换货约定匹配；不代表新订单已结清、已发货或真实平台已处理':status==='pending'?'约定资金流尚有待收或待退；未导入流水不自动视为已经完成':'实际收退超过当前约定；请核对是否重复收退或选择了错误策略');
 reasons.push('抵退额度和新结算目标为人工声明；不按数量均分原价，不自动将旧款记作新单支付，不新增退款或库存');
 return{...empty,status,reasons,amounts:{oldPaid,newPaid,oldRefund,expectedNewCash,expectedOldRefund,expectedDifference,actualDifference:newPaid-oldRefund,outstandingPay,outstandingRefund,combinedCash:oldPaid+newPaid-oldRefund,targetCombinedCash:oldPaid-input.oldCreditMinor+input.newSettlementMinor}};
}
export const EXCHANGE_SETTLEMENT_DEMO:ExchangeInput={source:'csv',sourceId:'exchange-difference-example',shop:'SHOP-X',channel:'offline',orderId:'NEW-X',lineId:'L1',label:'整行换货补差演练',strategy:'difference',oldCreditMinor:10000,newSettlementMinor:15000,observedAt:'2026-10-17T10:00:00+08:00',note:'人工核对整行退回，旧款一百元抵扣新款一百五十元'};
const original={source_id:'exchange-difference-example',shop_id:'SHOP-X',channel:'offline',sku_id:'SKU-OLD',spec:'one',currency:'CNY' as const,order_id:'OLD-X',line_id:'L1',order_at:'2026-10-14T10:00:00+08:00',quantity:1,allocated_discount_minor:0,platform_subsidy_minor:0};
export const EXCHANGE_SETTLEMENT_EVENTS:TransactionEvent[]=[
 {...original,event_id:'X-OLD',kind:'ordered',amount_minor:10000,event_at:original.order_at},
 {...original,event_id:'X-PAID',kind:'paid',amount_minor:10000,event_at:'2026-10-14T11:00:00+08:00'},
 {...original,event_id:'X-SHIPPED',kind:'shipped',amount_minor:0,event_at:'2026-10-14T12:00:00+08:00'},
 {...original,event_id:'X-RETURNED',kind:'returned',amount_minor:0,event_at:'2026-10-15T10:00:00+08:00'},
 {...original,event_id:'X-NEW',kind:'ordered',order_id:'NEW-X',sku_id:'SKU-NEW',amount_minor:15000,order_at:'2026-10-16T10:00:00+08:00',event_at:'2026-10-16T10:00:00+08:00',replaces_order_id:'OLD-X',replaces_line_id:'L1'},
 {...original,event_id:'X-DIFFERENCE',kind:'paid',order_id:'NEW-X',sku_id:'SKU-NEW',amount_minor:5000,quantity:0,order_at:'2026-10-16T10:00:00+08:00',event_at:'2026-10-16T11:00:00+08:00'},
];
const fields=[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS];
export const EXCHANGE_SETTLEMENT_CSV=fields.join(',')+'\n'+EXCHANGE_SETTLEMENT_EVENTS.map(e=>fields.map(f=>'"'+String(e[f]??'').replaceAll('"','""')+'"').join(',')).join('\n');
