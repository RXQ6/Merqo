import {PageHeader} from './PageHeader';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutionView } from '../../../../../packages/retail-domain/src/simulation';
import type { RetailRequest } from '../../../../../packages/retail-domain/src/operations';
import { DecisionValues } from './DecisionValues';
const labels={ready:'待模拟执行',failed:'执行失败',succeeded:'模拟已执行'};
export function ExecutionsPanel({initialRequestId,onBack,onCompensation,onBatches,onReview}:{initialRequestId:string|null;onBack:()=>void;onCompensation:(item:ExecutionView)=>void;onBatches:()=>void;onReview:(jobId:string|null)=>void}) {
  const [items,setItems]=useState<ExecutionView[]>([]);const [focus,setFocus]=useState('');const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [filter,setFilter]=useState('all');const [confirmed,setConfirmed]=useState(false);
  const pending=useRef(false);const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const call=useCallback(async(request:RetailRequest)=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
    try {
      const reply=await window.electronAPI.retailRequest(request);if(!reply.ok)throw new Error(reply.error);if(reply.kind!=='executions')throw new Error('执行服务返回类型不符');if(!alive.current)return;
      setItems(reply.data);if(request.op==='executions')setUncertain(false);if(reply.selectedId)setFocus(reply.selectedId);
      const selected=reply.data.find(v=>v.job.id===reply.selectedId);
      if(request.op==='simulation_execute'){if(selected?.status==='succeeded')setNotice('模拟执行已记录，请核对回执。');else setError('模拟执行未完成，查看失败原因后再决定是否重试。');}
      if(request.op==='execution_reconcile')setNotice(selected?.reconciliation?.matched?'回读核对一致。':'回读发现差异，已保留记录；请人工核查，不要重复执行。');
    }catch(e){if(alive.current){if(request.op==='simulation_execute')setUncertain(true);setError((e instanceof Error?e.message:'执行请求失败')+'。请先刷新执行记录确认结果。');}}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  },[]);
  useEffect(()=>{void call({op:'executions'});},[call]);
  const filtered=items.filter(v=>filter==='all'||v.status===filter);
  const selected=filtered.find(v=>v.job.id===focus)??filtered.find(v=>v.job.requestId===initialRequestId)??filtered[0];
  useEffect(()=>{setConfirmed(false);},[selected?.job.id,selected?.status]);
  const job=selected?.job;const receipt=selected?.receipt;const check=selected?.reconciliation;
  return <section data-testid="retail-executions"><PageHeader title="模拟执行记录" actions={<><div className="retail-inline-actions"><button onClick={()=>onReview(null)}>复盘与 Case</button><button onClick={onBatches}>执行批次</button><button onClick={onBack}>返回审批中心</button></div></>}>仅写入本机模拟业务账本。原始经营数据不变，不连接真实经营系统。</PageHeader>
    {error&&<div className="retail-alert error" role="alert">{error}</div>}{notice&&<div className="retail-alert success" role="status">{notice}</div>}
    <div className="retail-inline-actions retail-approval-filters"><label>执行状态<select aria-label="执行状态筛选" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button disabled={busy} onClick={()=>void call({op:'executions'})}>刷新执行记录</button><span className="retail-muted">最近100项；超时先刷新确认结果</span></div>
    <div className="retail-investigation-layout"><aside className="retail-investigation-list" aria-label="模拟执行列表">{!filtered.length&&<p>{busy?'正在读取…':'暂无执行项。先在审批中心批准一个符合条件的模拟方案。'}</p>}{filtered.map(v=><button key={v.job.id} aria-current={v.job.id===selected?.job.id?'true':undefined} onClick={()=>setFocus(v.job.id)}><strong>{v.job.scope.sku} · v{v.job.decisionVersion}</strong><span>{labels[v.status]}</span><small>{v.job.scenario==='margin'?'调整模拟商家券':v.job.scenario==='ads'?'调整模拟预算':'创建模拟补货请求'}</small></button>)}</aside>
    <article className="retail-investigation-body">{selected&&job&&<><h2>{job.scope.sku} · v{job.decisionVersion} · {labels[selected.status]}</h2><p>{job.scope.shop} / {job.scope.channel}{job.scope.warehouse?' / '+job.scope.warehouse:''}{job.scope.campaign?' / '+job.scope.campaign:''}</p><p>{job.explanation}</p>
      <h3>批准的模拟动作</h3><DecisionValues before={job.expectedBefore} after={job.expectedAfter} label="模拟执行预期值" afterTitle="批准目标值"/><p>批准有效至 {new Date(job.expiresAt).toLocaleString('zh-CN')}。执行前重新检查审批、证据与目标版本。</p>
      {selected.blockers.length>0&&<ul className="retail-reasons">{selected.blockers.map((text,i)=><li key={i}>{text}</li>)}</ul>}
      {!receipt&&selected.batchId&&<p>该动作已归入执行批次，请从批次逐项处理。<button onClick={onBatches}>查看执行批次</button></p>}
      {!receipt&&!selected.batchId&&<section aria-label="确认模拟执行"><label><input type="checkbox" aria-label="确认仅写本地模拟账本" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> 我已核对前后值，确认仅写本地模拟账本</label><div className="retail-inline-actions"><button className="retail-primary" disabled={busy||uncertain||!confirmed||selected.blockers.length>0} onClick={()=>void call({op:'simulation_execute',id:job.id,expectedVersion:job.decisionVersion,expectedActionHash:job.actionHash})}>{selected.status==='failed'?'重试模拟执行':'执行到模拟账本'}</button></div></section>}
      {receipt&&<section aria-label="模拟执行回执"><h3>成功回执</h3><button onClick={()=>onReview(job.id)}>创建或查看复盘</button><button onClick={()=>onCompensation(selected)}>申请补偿</button><p>本地请求号：{receipt.localRequestId}</p><p>{new Date(receipt.at).toLocaleString('zh-CN')} · 本机模拟执行员 · 目标版本 {receipt.before.version} → {receipt.after.version}</p><DecisionValues before={receipt.before.values} after={receipt.after.values} label="模拟执行实际值" afterTitle="实际模拟结果"/><p>该回执记录历史成功；批准后来失效也不会重新执行。补货未模拟入库，预算与券变化不代表真实经营效果。</p><button disabled={busy} onClick={()=>void call({op:'execution_reconcile',id:job.id})}>重新回读核对</button></section>}
      {check&&<section aria-label="执行回读核对"><h3>{check.matched?'回读核对一致':'回读核对存在差异'}</h3><p>{new Date(check.at).toLocaleString('zh-CN')} · 本地模拟状态</p>{check.differences.map(text=><p key={text}>{text}</p>)}<p className="retail-muted">这是该时刻的核对结果。目标可能后续变化，可重新回读；核对不执行或覆盖动作。</p></section>}
      {selected.attempts.length>0&&<section aria-label="执行尝试记录"><h3>执行尝试（最近50条）</h3><ol className="retail-approval-audit">{selected.attempts.map(a=><li key={a.id}><strong>{a.status==='succeeded'?'成功':'失败'}</strong><span>{new Date(a.at).toLocaleString('zh-CN')} · 本机模拟执行员</span><p>{a.reason}</p></li>)}</ol></section>}
      <details><summary>执行绑定与账本标识</summary><p>执行项及幂等键：{job.id}</p><p>申请：{job.requestId}；批准：{job.resolutionId}</p><p>动作：{job.actionHash}</p><p>证据：{job.evidenceHash}</p><p>批准时目标版本：{job.expectedStateVersion}；当前模拟版本：{selected.current?.version??0}</p></details>
    </>}</article></div>
  </section>;
}
