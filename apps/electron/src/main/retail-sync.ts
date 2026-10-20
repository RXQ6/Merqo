import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {getCredentialManager} from '@craft-agent/shared/credentials';
import {requestRetailWorker} from './retail-worker';
import {fetchDoudianOrderPage,type DoudianPageResult} from '../../../../packages/retail-domain/src/adapters/doudian-client';
import {SyncCredentialsSchema,type SyncView,type SyncJob,type SyncConnection} from '../../../../packages/retail-domain/src/adapters/sync-contract';
import type {RetailReply,RetailRequest} from '../../../../packages/retail-domain/src/operations';

type Workspace={rootPath:string;name:string};
type Context={workspace:Workspace;workspaceId:string;runner?:Promise<void>;rerun?:boolean;controller?:AbortController;initialized:Promise<void>};
const contexts=new Map<string,Context>();
const keyId=(workspaceId:string,sourceId:string)=>({type:'source_apikey' as const,workspaceId,sourceId});
async function worker(c:Context,input:unknown):Promise<SyncView>{const r=await requestRetailWorker(c.workspace,c.workspaceId,input,'sync');if(!r.ok)throw Error(r.error);if(r.kind!=='sync')throw Error('同步进程返回类型无效');return r.data;}
async function context(workspace:Workspace,workspaceId:string):Promise<Context>{
 let c=contexts.get(workspaceId);if(!c){c={workspace,workspaceId,initialized:Promise.resolve()};contexts.set(workspaceId,c);c.initialized=worker(c,{op:'sync_store_recover'}).then(()=>{}).catch(e=>{contexts.delete(workspaceId);throw e;});}await c.initialized;return c;
}
async function credentials(c:Context,connection:SyncConnection){
 if(!connection.credentialRef)throw Error('缺少店铺授权');
 const value=await getCredentialManager().get(keyId(c.workspaceId,connection.credentialRef));if(!value)throw Error('授权凭据不可用');
 const parsed=SyncCredentialsSchema.safeParse(JSON.parse(value.value));if(!parsed.success||parsed.data.expiresAt<=Date.now())throw Error('授权已过期或不可用');
 return{appKey:connection.appKey,appSecret:parsed.data.appSecret,accessToken:parsed.data.accessToken};
}
async function encrypt(c:Context,orders:Record<string,unknown>[]):Promise<string>{
 const id=keyId(c.workspaceId,'merqo-doudian-staging-key'),manager=getCredentialManager();let key=await manager.get(id);
 if(!key){key={value:randomBytes(32).toString('base64')};await manager.set(id,key);}
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key.value,'base64'),iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(orders),'utf8'),cipher.final()]);
 return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
}
function fixture(job:SyncJob,connection:SyncConnection):DoudianPageResult{
 const audit={provider:'doudian',method:'order.searchList',page:job.nextPage,size:job.window.size,updateStart:job.window.start,updateEnd:job.window.end,requestBodySha256:createHash('sha256').update(JSON.stringify(job.window)).digest('hex'),status:'prepared_offline' as const};
 if(connection.fixture==='rate_limit'&&job.nextPage===1&&job.attempts<2)return{ok:false,kind:'http',httpStatus:429,retryable:true,audit};
 if(connection.fixture==='invalid_response'&&job.nextPage===1)return{ok:false,kind:'invalid_response',retryable:false,audit};
 const orders=Array.from({length:7},(_,i)=>({synthetic:true,fixture_order_id:`DEMO-${i+1}`})).slice(job.nextPage*job.window.size,(job.nextPage+1)*job.window.size);
 return{ok:true,orders,page:job.nextPage,size:job.window.size,reportedTotal:7,audit:{...audit,status:'received_unmapped',receivedAt:Date.now(),responseSha256:createHash('sha256').update(JSON.stringify(orders)).digest('hex'),count:orders.length,reportedTotal:7}};
}
const failureMessage=(r:Extract<DoudianPageResult,{ok:false}>)=>r.kind==='http'?`接口返回 HTTP ${r.httpStatus}`:r.kind==='platform'?`平台拒绝请求，代码 ${r.platformCode}`:r.kind==='invalid_response'?'响应格式或分页信息不一致':r.kind==='cancelled'?'请求已取消':'网络失败或请求超时';
async function execute(c:Context){
 while(true){
  const view=await worker(c,{op:'sync_store_view'}),job=view.jobs.find(j=>j.status==='queued'||j.status==='retry_wait');if(!job)return;
  if(job.status==='retry_wait'&&(job.retryAt??0)>Date.now()){await new Promise(resolve=>setTimeout(resolve,Math.min(500,(job.retryAt??0)-Date.now())));continue;}
  let claimed:SyncView;
  try{claimed=await worker(c,{op:'sync_store_claim',id:job.id,expectedEpoch:job.epoch});}
  catch{try{await worker(c,{op:'sync_store_failure',id:job.id,expectedEpoch:job.epoch,message:'连接配置或授权不可用，请重新检查',retryable:false,blocked:true});}catch{}return;}
  const running=claimed.jobs.find(j=>j.id===job.id)!,connection=claimed.connection!,controller=new AbortController();c.controller=controller;
  try{
   let result:DoudianPageResult;
   if(connection.mode==='fixture'){
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,700);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('paused'));},{once:true});});result=fixture(running,connection);
   }else result=await fetchDoudianOrderPage({update_time_start:running.window.start,update_time_end:running.window.end,page:running.nextPage,size:running.window.size},await credentials(c,connection),{signal:controller.signal});
   if(controller.signal.aborted)continue;
   if(!result.ok){await worker(c,{op:'sync_store_failure',id:running.id,expectedEpoch:running.epoch,message:failureMessage(result),retryable:result.retryable,blocked:result.kind==='platform'||result.kind==='http'&&[401,403].includes(result.httpStatus??0)});continue;}
   const encrypted=await encrypt(c,result.orders);
   try{await worker(c,{op:'sync_store_page',id:running.id,expectedEpoch:running.epoch,page:result.page,count:result.orders.length,reportedTotal:result.reportedTotal,responseSha256:result.audit.responseSha256,encrypted});}
   catch{await worker(c,{op:'sync_store_failure',id:running.id,expectedEpoch:running.epoch,message:'分页或暂存提交失败，断点未推进；请核对后重试',retryable:false});}
  }catch{if(!controller.signal.aborted){try{await worker(c,{op:'sync_store_failure',id:running.id,expectedEpoch:running.epoch,message:'凭据或暂存不可用，请检查授权后重试',retryable:false,blocked:true});}catch{}}}
  finally{if(c.controller===controller)c.controller=undefined;}
 }
}
function kick(c:Context){if(c.runner){c.rerun=true;return;}c.runner=execute(c).catch(()=>{}).finally(()=>{c.runner=undefined;if(c.rerun){c.rerun=false;kick(c);}});}
export async function handleRetailSync(workspace:Workspace,workspaceId:string,request:RetailRequest):Promise<RetailReply>{
 const c=await context(workspace,workspaceId);
 if(request.op==='sync_view')return{ok:true,kind:'sync',data:await worker(c,{op:'sync_store_view'})};
 if(request.op==='sync_configure'){
  let ref:string|undefined;
  if(request.config.mode==='live'){
   if(!request.credentials||request.credentials.expiresAt<=Date.now())throw Error('请填写有效授权和到期时间');
   ref=crypto.randomUUID();await getCredentialManager().set(keyId(workspaceId,ref),{value:JSON.stringify(request.credentials)});
  }
  try{const data=await worker(c,{op:'sync_store_configure',expectedRevision:request.expectedRevision,config:request.config,credentialRef:ref,expiresAt:request.credentials?.expiresAt});c.controller?.abort();return{ok:true,kind:'sync',data};}
  catch{if(ref)await getCredentialManager().delete(keyId(workspaceId,ref));throw Error('保存连接失败，请刷新配置版本后重试');}
 }
 if(request.op==='sync_check'){
  const view=await worker(c,{op:'sync_store_view'}),connection=view.connection;if(!connection)throw Error('请先保存连接');let ok=false,message='';
  if(connection.mode==='fixture'){ok=true;message='演练检查通过；合成数据，未连接真实店铺';}
  else{try{const now=Math.floor(Date.now()/1000),r=await fetchDoudianOrderPage({update_time_start:now-60,update_time_end:now,size:1},await credentials(c,connection));ok=r.ok;message=r.ok?'订单只读接口检查通过；店铺归属及业务字段仍待对账':failureMessage(r);}catch{message='授权凭据不可用或已过期，请重新配置';}}
  return{ok:true,kind:'sync',data:await worker(c,{op:'sync_store_check',expectedRevision:connection.revision,ok,message})};
 }
 if(request.op==='sync_create'){const data=await worker(c,{op:'sync_store_create',expectedRevision:request.expectedRevision,window:request.window});kick(c);return{ok:true,kind:'sync',data};}
 if(request.op==='sync_control'){
  const data=await worker(c,{op:'sync_store_control',id:request.id,expectedEpoch:request.expectedEpoch,action:request.action});if(request.action==='pause')c.controller?.abort();else kick(c);return{ok:true,kind:'sync',data};
 }
 throw Error('不支持的同步操作');
}
