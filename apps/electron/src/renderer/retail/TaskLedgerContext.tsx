import type {BusinessTask} from '../../../../../packages/retail-domain/src/business-task-contract';
import {OPERATIONAL_NAMES} from '../../../../../packages/retail-domain/src/operational-evidence-contract';
export function TaskLedgerContext({task}:{task:BusinessTask}){
 const c=task.operationalContext;if(!c)return null;
 return <section className="experience-record" aria-label="任务台账来源"><h3>任务台账来源</h3><p>任务创建时引用 {c.items.length} 条台账记录，后续处理不改写此处的历史依据。原始内容保存在关联调查中。</p>{c.findings.map(f=><p key={f.chain}>{f.title}：{f.detail}</p>)}<details><summary>查看冻结台账索引</summary>{c.items.map(i=><p key={i.id}>{OPERATIONAL_NAMES[i.kind]} / {i.recordId} / {i.hash.slice(0,16)}；{i.reasons.join('；')}</p>)}<small>来源 {c.scope.sourceId??'未声明'}；整体摘要 {c.hash}</small></details></section>;
}
