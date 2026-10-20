import type {BundleNode} from '../../../../../packages/retail-domain/src/operations';
export function BundleTree({parts}:{parts:BundleNode[]}){
 return <ul>{parts.map((part,index)=><li key={index}>{part.sku_id} · {part.spec} × {part.quantity}；单位成本 {part.unit_cost_minor===null?'未知':'¥'+(part.unit_cost_minor/100).toFixed(2)}{part.children&&<BundleTree parts={part.children}/>}</li>)}</ul>;
}
