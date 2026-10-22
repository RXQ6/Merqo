import {useEffect,useRef,useState} from 'react';
import type {WikiData} from '../../../../../packages/retail-domain/src/wiki-contract';
import {workbenchRequest} from './workbench-api';
import {WikiMarkdown} from './WikiMarkdown';
type View=Extract<WikiData,{view:'wiki_references'}>;
export function WikiReferences({investigationId}:{investigationId:string}){
  const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);const pending=useRef(false);
  useEffect(()=>{let alive=true;setView(null);void workbenchRequest({op:'wb_wiki_references',investigationId}).then(d=>{if(alive&&d.view==='wiki_references')setView(d);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[investigationId,revision]);
  async function cite(itemId:string,expectedVersion:number){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{const d=await workbenchRequest({op:'wb_wiki_reference',investigationId,itemId,expectedVersion});if(d.view==='wiki_references')setView(d);}catch(e){setError(String(e));}finally{pending.current=false;setBusy(false);}}
  return <section className="retail-wiki-references" aria-label="调查 Wiki 引用"><h3>经营知识参考</h3><p>按场景、店铺、商品和业务日期匹配。引用保存此时的版本，作为调查补充说明；不改写原报告、不替代事实证据。</p>{error&&<p role="alert">{error}</p>}{view?.warnings.map(w=><p key={w} className="retail-alert">{w}</p>)}<button disabled={busy} onClick={()=>setRevision(v=>v+1)}>刷新相关知识</button>
    <h4>本次已引用</h4>{view?.references.map(r=><details key={r.item.id+':'+r.item.version}><summary>{r.item.title} · 冻结 v{r.item.version}</summary><WikiMarkdown body={r.item.body}/><button onClick={()=>window.dispatchEvent(new CustomEvent('merqo:wiki-open',{detail:{id:r.item.id}}))}>打开知识中心</button></details>)}{view&&!view.references.length&&<p>尚未引用知识。</p>}
    <details><summary>查看适用知识（最多20篇）</summary>{view?.candidates.map(c=><article key={c.item.id}><strong>{c.item.title} · v{c.item.version}</strong><p>{c.reason}</p><details><summary>阅读文档</summary><WikiMarkdown body={c.item.body}/></details><button disabled={busy||view.references.some(r=>r.item.id===c.item.id&&r.item.version===c.item.version)} onClick={()=>void cite(c.item.id,c.item.version)}>引用此知识版本</button></article>)}{view&&!view.candidates.length&&<p>暂无已发布且适用的知识，请先在知识中心维护。</p>}</details>
  </section>;
}
