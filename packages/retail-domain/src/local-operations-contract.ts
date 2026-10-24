import {z} from 'zod';
const id=z.string().trim().min(1).max(128),note=z.string().trim().min(10).max(1000),amount=z.number().int().positive().max(100000000),hash=z.string().regex(/^[a-f0-9]{64}$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
export const LocalFinanceInputSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('payable'),sourceId:id,shop:id,purchaseId:id,lineId:id,supplier:id,amountMinor:amount,currency:z.literal('CNY'),dueOn:date,evidenceRef:id,note}),
 z.strictObject({kind:z.literal('payment'),payableId:z.string().uuid(),amountMinor:amount,receiptRef:id,note}),
 z.strictObject({kind:z.literal('supplier_refund'),paymentId:z.string().uuid(),amountMinor:amount,receiptRef:id,note}),
]);
export type LocalFinanceInput=z.infer<typeof LocalFinanceInputSchema>;
export interface LocalFinanceEvent {id:string;at:string;input:LocalFinanceInput;payableId:string;sourceId:string;shop:string;purchaseId:string;lineId:string;authority:'operator_declared';}
export interface LocalPayable {id:string;sourceId:string;shop:string;purchaseId:string;lineId:string;supplier:string;amountMinor:number;paidMinor:number;refundedMinor:number;balanceMinor:number;dueOn:string;overdue:boolean;}
export interface LocalFinancePlan {id:string;at:string;expiresAt:string;input:LocalFinanceInput;hash:string;stateHash:string;summary:string;}
export interface LocalFinanceReceipt {id:string;at:string;plan:LocalFinancePlan;event:LocalFinanceEvent;replayed?:boolean;}
export interface LocalReview {id:string;at:string;receiptId:string;conclusion:'consistent'|'needs_evidence'|'exception';note:string;beforeHash:string;afterHash:string;payable:LocalPayable;}
export interface LocalOperationsView {payables:LocalPayable[];total:number;events:LocalFinanceEvent[];receipts:LocalFinanceReceipt[];reviews:LocalReview[];stateHash:string;authority:'operator_declared';}
export interface ArrivalPlan {id:string;at:string;expiresAt:string;hash:string;sourceId:string;shop:string;warehouse:string;receiptEventId:string;state:'sellable'|'quarantine';quantity:number;summary:string;}
export const ArrivalInputSchema=z.strictObject({sourceId:id,shop:id,receiptEventId:id,state:z.enum(['sellable','quarantine']),quantity:z.number().int().positive().max(1000000)});
export type ArrivalInput=z.infer<typeof ArrivalInputSchema>;
export const FulfillmentInputSchema=z.strictObject({sourceId:id,shop:id,channel:id,warehouse:id,orderId:id,lineId:id,sku:id,spec:id,orderRef:id,quantity:z.number().int().positive().max(1000000),shipmentRef:id,note});
export type FulfillmentInput=z.infer<typeof FulfillmentInputSchema>;
export interface FulfillmentPlan {id:string;at:string;expiresAt:string;hash:string;input:FulfillmentInput;summary:string;selections:Array<{reservationId:string;batchId:string;quantity:number}>;}
export interface FulfillmentReceipt {id:string;at:number;plan:FulfillmentPlan;transactionEventId:string;warehouseEventIds:string[];authority:'operator_declared';replayed?:boolean;}
export interface FulfillmentReview {id:string;at:string;receiptId:string;note:string;conclusion:'consistent'|'needs_evidence'|'exception';warehouseEventCount:number;transactionEventFound:boolean;stateHash:string;}
export interface FulfillmentView {receipts:FulfillmentReceipt[];reviews:FulfillmentReview[];stateHash:string;}
export const LocalOperationsSchemas=[
 z.strictObject({op:z.literal('local_ops_view')}),
 z.strictObject({op:z.literal('local_ops_preview'),input:LocalFinanceInputSchema}),
 z.strictObject({op:z.literal('local_ops_confirm'),id:z.string().uuid(),reviewHash:hash}),
 z.strictObject({op:z.literal('local_ops_review'),receiptId:z.string().uuid(),expectedStateHash:hash,conclusion:z.enum(['consistent','needs_evidence','exception']),note}),
 z.strictObject({op:z.literal('local_ops_arrival_preview'),input:ArrivalInputSchema}),
 z.strictObject({op:z.literal('local_ops_arrival_confirm'),id:z.string().uuid(),reviewHash:hash}),
 z.strictObject({op:z.literal('local_ops_fulfillment_preview'),input:FulfillmentInputSchema}),
 z.strictObject({op:z.literal('local_ops_fulfillment_confirm'),id:z.string().uuid(),reviewHash:hash}),
 z.strictObject({op:z.literal('local_ops_fulfillment_view')}),
 z.strictObject({op:z.literal('local_ops_fulfillment_review'),receiptId:z.string().uuid(),expectedStateHash:hash,note,conclusion:z.enum(['consistent','needs_evidence','exception'])}),
] as const;
export type LocalOperationsRequest=z.infer<typeof LocalOperationsSchemas[number]>;
export type LocalOperationsData={view:'fulfillment';data:FulfillmentView}|{view:'fulfillment_plan';plan:FulfillmentPlan}|{view:'fulfillment_receipt';receipt:FulfillmentReceipt}|{view:'finance';data:LocalOperationsView}|{view:'finance_plan';plan:LocalFinancePlan}|{view:'finance_receipt';receipt:LocalFinanceReceipt}|{view:'arrival_plan';plan:ArrivalPlan}|{view:'arrival_receipt';receipt:import('./warehouse-contract').WarehouseReceipt};
