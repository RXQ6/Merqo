import {BrowserWindow,dialog,type WebContents} from 'electron';
import {spawn} from 'node:child_process';import {join} from 'node:path';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {loadStoredConfig,saveConfig} from '@craft-agent/shared/config';
import {createWorkspaceAtPath} from '../../../../packages/shared/src/workspaces/storage';
import {getCredentialManager} from '@craft-agent/shared/credentials';
import {freezeRetailWorkers} from './retail-worker';
import type {RetailRequest,RetailReply} from '../../../../packages/retail-domain/src/operations';
import type {BackupSummary} from '../../../../packages/retail-domain/src/backup-contract';
interface Secret {sourceId:string;value:string;}
interface Preview {workspaceId:string;sender:number;path:string;fileHash:string;summary:BackupSummary;expires:number;}
const previews=new Map<string,Preview>();
async function run(root:string,workspaceId:string,name:string,input:unknown,archive='',target=''):Promise<{summary?:BackupSummary;fileHash?:string;secrets?:Secret[];refs?:string[];needsStagingKey?:boolean;connectionHash?:string}>{
 const appRoot=process.env.CRAFT_APP_ROOT||process.cwd(),script=join(appRoot,'scripts','retailpilot-backup-worker.ts');if(!existsSync(script))throw Error('备份工作进程缺失，请更新应用');
 return await new Promise((resolve,reject)=>{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(process.env.CRAFT_BUN||'bun',[script,root,archive,target,workspaceId,name],{cwd:appRoot,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',done=false;const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else{try{const r=JSON.parse(output);if(!r.ok)throw Error(r.error);resolve(r.data);}catch(e){reject(e);}}};const timer=setTimeout(()=>{child.kill();finish(Error('备份操作超时，请核对目标文件或恢复目录后再重试'));},120000);child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{output+=s;if(output.length>1000000){child.kill();finish(Error('备份进程返回超限'));}});child.stderr.resume();child.on('error',e=>finish(e));child.on('close',()=>finish());child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));});
}
export async function handleRetailBackup(workspace:{rootPath:string;name:string},workspaceId:string,sender:WebContents,r:RetailRequest,onRestored:(id:string)=>void):Promise<RetailReply>{
 const parent=BrowserWindow.fromWebContents(sender);if(!parent)throw Error('备份需要有效的本机窗口');
 for(const [id,p]of previews)if(p.expires<Date.now()||p.sender===sender.id&&r.op==='backup_preview')previews.delete(id);
 const manager=getCredentialManager();const key=(id:string,sourceId:string)=>({type:'source_apikey' as const,workspaceId:id,sourceId});
 if(r.op==='backup_create'){
  const choice=await dialog.showSaveDialog(parent,{title:'保存加密经营备份',defaultPath:`Merqo-${new Date().toISOString().slice(0,10)}.merqo-backup`,filters:[{name:'Merqo加密备份',extensions:['merqo-backup']}]});if(choice.canceled||!choice.filePath)return{ok:true,kind:'backup',data:{action:'cancelled'}};
  if(!choice.filePath.toLowerCase().endsWith('.merqo-backup'))throw Error('备份文件必须使用 .merqo-backup 扩展名');
  const data=await freezeRetailWorkers(workspaceId,async()=>{const inventory=await run(workspace.rootPath,workspaceId,workspace.name,{op:'inventory'}),secrets:Secret[]=[];for(const sourceId of [...inventory.refs??[],...(inventory.needsStagingKey?['merqo-doudian-staging-key']:[])]){const stored=await manager.get(key(workspaceId,sourceId));if(!stored)throw Error('接入凭据或暂存密钥缺失，无法生成完整备份');secrets.push({sourceId,value:stored.value});}return await run(workspace.rootPath,workspaceId,workspace.name,{op:'create',password:r.password,connectionHash:inventory.connectionHash,secrets},choice.filePath);});
  return{ok:true,kind:'backup',data:{action:'created',summary:data.summary!,path:choice.filePath}};
 }
 if(r.op==='backup_preview'){
  const choice=await dialog.showOpenDialog(parent,{title:'选择加密经营备份',properties:['openFile'],filters:[{name:'Merqo加密备份',extensions:['merqo-backup']}]});if(choice.canceled||!choice.filePaths[0])return{ok:true,kind:'backup',data:{action:'cancelled'}};
  const result=await run(workspace.rootPath,workspaceId,workspace.name,{op:'preview',password:r.password},choice.filePaths[0]),token=crypto.randomUUID();previews.set(token,{workspaceId,sender:sender.id,path:choice.filePaths[0],fileHash:result.fileHash!,summary:result.summary!,expires:Date.now()+600000});
  return{ok:true,kind:'backup',data:{action:'preview',summary:result.summary!,token}};
 }
 if(r.op==='backup_restore'){
  const p=previews.get(r.token);if(!p||p.workspaceId!==workspaceId||p.sender!==sender.id||p.expires<Date.now())throw Error('恢复预览已过期，请重新选择备份');
  const choice=await dialog.showOpenDialog(parent,{title:'选择恢复位置（将新建独立工作空间文件夹）',properties:['openDirectory']});if(choice.canceled||!choice.filePaths[0])return{ok:true,kind:'backup',data:{action:'cancelled'}};
  // Consume only when a destination was chosen. A failed or repeated confirmation must be re-previewed.
  previews.delete(r.token);const target=join(choice.filePaths[0],'Merqo-Restored-'+crypto.randomUUID());
  const result=await run(workspace.rootPath,workspaceId,workspace.name,{op:'restore',password:r.password,fileHash:p.fileHash},p.path,target);
  const created=createWorkspaceAtPath(target,r.name);const installed:string[]=[];
  try{for(const secret of result.secrets??[]){await manager.set(key(created.id,secret.sourceId),{value:secret.value});installed.push(secret.sourceId);if((await manager.get(key(created.id,secret.sourceId)))?.value!==secret.value)throw Error('恢复凭据回读校验失败');}
   const marker=join(target,'retail','restored-history.json');writeFileSync(marker,JSON.stringify({...JSON.parse(readFileSync(marker,'utf8')),ready:true}));
   const config=loadStoredConfig();if(!config)throw Error('工作空间配置不可用');config.workspaces.push({id:created.id,name:r.name,slug:created.slug,rootPath:target,createdAt:created.createdAt});saveConfig(config);
  }catch(e){const marker=join(target,'retail','restored-history.json');writeFileSync(marker,JSON.stringify({...JSON.parse(readFileSync(marker,'utf8')),ready:false}));const current=loadStoredConfig();if(current?.workspaces.some(w=>w.id===created.id)){current.workspaces=current.workspaces.filter(w=>w.id!==created.id);saveConfig(current);}for(const sourceId of installed)await manager.delete(key(created.id,sourceId));writeFileSync(join(target,'RESTORE-INCOMPLETE.txt'),'恢复注册或凭据保存失败。此目录未完成恢复，请重新从原始加密备份恢复。');throw e;}
  onRestored(created.id);return{ok:true,kind:'backup',data:{action:'restored',summary:result.summary!,path:target,workspaceId:created.id}};
 }
 throw Error('不支持的备份操作');
}
