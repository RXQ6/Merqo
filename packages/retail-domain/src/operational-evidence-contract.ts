export const OPERATIONAL_NAMES={transactions:'交易与退款',costs:'成本与贡献',procurement:'采购到货',warehouse:'仓库事件',finance:'采购应付与付款'} as const;
export type OperationalKind=keyof typeof OPERATIONAL_NAMES;
export interface OperationalItem {
 id:string;kind:OperationalKind;recordId:string;sourceId:string;businessAt:string;
 status:'scope_matched'|'context_only';reasons:string[];hash:string;record:Record<string,unknown>;
}
export interface OperationalEvidence {
 version:'operational-evidence-v1';frozenAt:string;hash:string;
 scope:{source:'demo'|'csv';sourceId:string|null;shop:string;channel:string;sku:string;spec:string|null;start:string|null;end:string|null};
 items:OperationalItem[];missing:OperationalKind[];truncated:OperationalKind[];issues:string[];
 findings:Array<{chain:'trade_contribution'|'purchase_stock';title:string;detail:string;itemIds:string[]}>;
 limitation:string;
}
