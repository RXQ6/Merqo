import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {z} from 'zod';
import {backupInventory,captureBackup,writeBackup,readBackup,backupSummary,restoreBackup} from '../packages/retail-domain/src/backup';
const [root,archive,target,workspaceId,workspaceName]=process.argv.slice(2);
try{
 if(!root)throw Error('缺少可信工作空间');
 const input=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('inventory')}),
  z.strictObject({op:z.literal('create'),password:z.string(),connectionHash:z.string(),secrets:z.array(z.strictObject({sourceId:z.string(),value:z.string()}))}),
  z.strictObject({op:z.literal('preview'),password:z.string()}),
  z.strictObject({op:z.literal('restore'),password:z.string(),fileHash:z.string()}),
 ]).parse(JSON.parse(await Bun.stdin.text()));
 let result:unknown;
 if(input.op==='inventory')result=backupInventory(join(root,'retail'));
 else if(input.op==='create'){
  if(!archive||!workspaceId||!workspaceName)throw Error('缺少可信备份参数');
  const marker=join(root,'retail','restored-history.json');const owner=existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')).originalWorkspaceId:workspaceId;
  result={summary:writeBackup(captureBackup(join(root,'retail'),owner,workspaceName,input.secrets,input.connectionHash),input.password,archive)};
 }else{
  if(!archive)throw Error('缺少备份文件');const {payload,fileHash}=readBackup(archive,input.password,input.op==='restore'?input.fileHash:undefined);
  if(input.op==='preview')result={summary:backupSummary(payload),fileHash};
  else {if(!target)throw Error('缺少可信恢复目录');result={summary:restoreBackup(payload,target),secrets:payload.secrets};}
 }
 console.log(JSON.stringify({ok:true,data:result}));
}catch(error){console.log(JSON.stringify({ok:false,error:error instanceof Error?error.message:'备份操作失败'}));process.exitCode=1;}
