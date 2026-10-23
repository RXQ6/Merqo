import type { BusinessEvidence } from '../../../../../packages/retail-domain/src/workbench-contract';
import {workbenchRequest} from './workbench-api';
import {useState} from 'react';
const names:Record<string,string>={revenueMinor:'单件商品收入（分）',profitMinor:'单件毛利（分）',marginBps:'毛利率（基点）',totalRevenueMinor:'快照商品收入（分）',totalProfitMinor:'快照毛利（分）',available:'即时可售',coverageDays:'覆盖天数',proposedQuantity:'补货建议量',roas:'ROAS',spendMinor:'花费（分）',currentRoas:'当前ROAS',baselineRoas:'对照ROAS'};
const states:Record<string,string>={normal:'正常',low_margin:'毛利预警',warning:'预警',needs_evidence:'待补证'};
export function BusinessEvidenceCard({evidence}:{evidence:BusinessEvidence}){
  const [linkError,setLinkError]=useState('');
  async function openProduct(){try{const d=await workbenchRequest({op:'wb_exp_resolve',recordId:evidence.id});if(d.view==='resolved_product')window.dispatchEvent(new CustomEvent('merqo:product-open',{detail:{id:d.entity.id}}));}catch(e){setLinkError(e instanceof Error?e.message:'打开失败');}}
  const values='kind'in evidence?evidence.metrics:evidence.calculation;
  const fields=Object.entries(values).filter(([key,value])=>key in names&&(value===null||typeof value==='number'));
  return <article className="retail-evidence-card"><header><strong>{evidence.row.date} · {'kind'in evidence?evidence.kind==='inventory'?'库存':'广告':'毛利'}</strong><span>{states[evidence.status]}</span></header>
    <p className="retail-muted">{evidence.source==='demo'?'合成演示':'CSV声明'} · {evidence.row.shop_id} / {evidence.row.sku_id} · {'spec'in evidence.row?evidence.row.spec:'规格未声明'}</p>
    <button onClick={()=>void openProduct()}>查看商品经营档案</button>{linkError&&<p role="alert">{linkError}</p>}
    <dl>{fields.map(([key,value])=><div key={key}><dt>{names[key]}</dt><dd>{value===null?'未知':String(value)}</dd></div>)}</dl>
    <p className="retail-muted">这是原快照事实，多个日期/版本不得相加。证据 {evidence.id} · 规则 {evidence.ruleVersion}</p>
    <details><summary>原始证据与来源声明</summary><pre>{JSON.stringify(evidence,null,2)}</pre></details>
  </article>;
}
