import {useRef,useState} from 'react';
import type {BackupResult} from '../../../../../packages/retail-domain/src/backup-contract';
import type {RetailRequest} from '../../../../../packages/retail-domain/src/operations';
export function BackupPanel(){
 const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[name,setName]=useState('恢复的经营工作空间'),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<BackupResult|null>(null);
 const inFlight=useRef(false);
 async function send(op:'backup_create'|'backup_preview'|'backup_restore'){
  if(inFlight.current)return;setError('');if(password.length<12){setError('备份密码至少12个字符');return;}
  if(op==='backup_create'&&password!==confirmation){setError('两次备份密码不一致');return;}
  if(op==='backup_restore'&&(!result?.token||!reviewed))return;
  inFlight.current=true;setBusy(true);try{const input:RetailRequest=op==='backup_restore'?{op,token:result!.token!,password,name,confirmed:true}:{op,password};const reply=await window.electronAPI.retailRequest(input);if(!reply.ok)throw Error(reply.error);if(reply.kind!=='backup')throw Error('备份响应无效');if(reply.data.action!=='cancelled'){setResult(reply.data);setReviewed(false);if(reply.data.action!=='preview'){setPassword('');setConfirmation('');}}}catch(e){setError(e instanceof Error?e.message:'备份失败');if(op==='backup_restore')setResult(null);}finally{inFlight.current=false;setBusy(false);}
 }
 return <section className="retail-panel retail-operational-panel" aria-label="经营备份与恢复"><details><summary>经营数据完整备份与恢复</summary><div className="retail-sync-form">
 <p>密码加密保存经营数据库、同步进度、未清理的暂存页及其密钥和当前接入凭据。密码无法找回，请自行保管。不包含聊天记录、附件、AI模型密钥及其他工作空间。当前上限为64 MB数据库、100 MB加密文件。</p>
 <div className="retail-form-grid"><label>备份密码<input type="password" autoComplete="new-password" aria-label="备份密码" maxLength={256} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label><label>再次输入密码（创建备份时）<input type="password" autoComplete="new-password" aria-label="确认备份密码" disabled={busy} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label></div>
 <div className="retail-inline-actions"><button disabled={busy} onClick={()=>void send('backup_create')}>选择位置并创建加密备份</button><button disabled={busy} onClick={()=>void send('backup_preview')}>选择备份并校验</button></div>
 {busy&&<p role="status">正在处理备份，请等待完成…</p>}{error&&<p role="alert">{error}</p>}
 {result?.summary&&<div className="retail-operational-result" aria-label="备份校验结果"><h3>{result.action==='created'?'备份已保存':result.action==='restored'?'已恢复为独立工作空间':'备份校验通过'}</h3><p>{result.summary.workspaceName} · {new Date(result.summary.createdAt).toLocaleString()} · {result.summary.files.length}个数据库 · {result.summary.credentialCount}项接入凭据/密钥 · {(result.summary.bytes/1024/1024).toFixed(2)} MB</p><ul>{result.summary.files.map(f=><li key={f.name}>{f.name} · {f.bytes}字节 · SHA256 {f.sha256.slice(0,16)}</li>)}</ul>{result.path&&<p>位置：{result.path}</p>}
 {result.action==='preview'&&<><p>恢复会在所选位置新建工作空间，原工作空间保留。自动同步和巡检停用，接入需重新检测。历史审批、执行和补偿仅作追溯，恢复工作空间不能执行这些动作。</p><label>恢复工作空间名称<input aria-label="恢复工作空间名称" value={name} maxLength={80} disabled={busy} onChange={e=>setName(e.target.value)}/></label><label className="retail-checkbox"><input type="checkbox" disabled={busy} checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>我已核对备份范围，并确认恢复为独立工作空间</label><button disabled={busy||!reviewed||!name.trim()} onClick={()=>void send('backup_restore')}>选择恢复位置并确认恢复</button><p className="retail-muted">预览10分钟有效；确认时重新验证密码和文件摘要。</p></>}
 </div>}
 </div></details></section>;
}
