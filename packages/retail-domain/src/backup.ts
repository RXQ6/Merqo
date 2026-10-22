// Trusted Bun worker only. Plaintext database images and credentials never go to the renderer.
import {Database} from 'bun:sqlite';
import {createHash,randomBytes,createCipheriv,createDecipheriv,scryptSync} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {BackupPassword,type BackupSummary} from './backup-contract';
import {SyncCredentialsSchema} from './adapters/sync-contract';
export const BACKUP_FILES=['operations.sqlite','operations.sqlite.signals.sqlite','operations.sqlite.investigations.sqlite','operations.sqlite.checks.sqlite','operations.sqlite.sync.sqlite','operations.sqlite.transactions.sqlite','operations.sqlite.policy.sqlite','operations.sqlite.catalog.sqlite'] as const;
const MAX_DATABASE_BYTES=64*1024*1024,MAX_ARCHIVE_BYTES=100*1024*1024;
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const secretSchema=z.strictObject({sourceId:z.union([z.literal('merqo-doudian-staging-key'),z.string().uuid()]),value:z.string().min(1).max(100000)});
export type BackupSecret=z.infer<typeof secretSchema>;
const payloadSchema=z.strictObject({version:z.literal(1),id:z.string().uuid(),createdAt:z.number().int().positive(),workspaceId:z.string().min(1).max(128),workspaceName:z.string().min(1).max(200),files:z.array(z.strictObject({name:z.enum(BACKUP_FILES),data:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(BACKUP_FILES.length),secrets:z.array(secretSchema).max(2)});
type Payload=z.infer<typeof payloadSchema>;
const supportedVersions:Record<typeof BACKUP_FILES[number],number>={'operations.sqlite':2,'operations.sqlite.signals.sqlite':0,'operations.sqlite.investigations.sqlite':9,'operations.sqlite.checks.sqlite':1,'operations.sqlite.sync.sqlite':0,'operations.sqlite.transactions.sqlite':0,'operations.sqlite.policy.sqlite':0,'operations.sqlite.catalog.sqlite':0};
function checkVersion(db:Database,name:typeof BACKUP_FILES[number]){if(db.query<{user_version:number},[]>('PRAGMA user_version').get()!.user_version>supportedVersions[name])throw Error('备份数据库版本高于当前程序，请更新应用');}
export function backupSummary(p:Payload):BackupSummary {const files=p.files.map(f=>({name:f.name,bytes:Buffer.byteLength(f.data,'base64'),sha256:f.sha256}));return{id:p.id,createdAt:p.createdAt,workspaceName:p.workspaceName,files,credentialCount:p.secrets.length,bytes:files.reduce((n,f)=>n+f.bytes,0)};}
function openImage(data:Buffer){
 // sqlite3_serialize includes committed WAL pages; in-memory images have no WAL file.
 const image=Buffer.from(data);image[18]=1;image[19]=1;
 const db=Database.deserialize(image);db.exec('PRAGMA trusted_schema=OFF');
 try{const check=db.query<{integrity_check:string},[]>('PRAGMA integrity_check').all();if(check.length!==1||check[0]?.integrity_check!=='ok')throw Error('数据库完整性检查失败');return db;}catch(e){db.close();throw e;}
}
function syncInventory(db:Database){
 const tables=new Set(db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name));
 const rows=tables.has('sync_connection')?db.query<{json:string},[]>('SELECT json FROM sync_connection').all():[];
 const ref=rows.length?JSON.parse(rows[0]!.json).credentialRef as string|undefined:undefined;
 const encrypted=tables.has('sync_pages')?db.query<{encrypted:string},[]>("SELECT encrypted FROM sync_pages WHERE length(encrypted)>0").all().map(r=>r.encrypted):[];
 return{connectionHash:hash(JSON.stringify(rows)),refs:ref?[z.string().uuid().parse(ref)]:[],encrypted};
}
export function backupInventory(retail:string){const file=join(retail,'operations.sqlite.sync.sqlite');if(!existsSync(file))return{connectionHash:hash('[]'),refs:[] as string[],needsStagingKey:false};const db=new Database(file,{readonly:true});try{const v=syncInventory(db);return{connectionHash:v.connectionHash,refs:v.refs,needsStagingKey:!!v.encrypted.length};}finally{db.close();}}
function validateSecrets(p:Payload){
 if(new Set(p.secrets.map(s=>s.sourceId)).size!==p.secrets.length)throw Error('备份凭据重复');
 const image=p.files.find(f=>f.name==='operations.sqlite.sync.sqlite');if(!image){if(p.secrets.length)throw Error('备份凭据范围无效');return;}
 const db=openImage(Buffer.from(image.data,'base64'));try{const v=syncInventory(db),required=new Set([...v.refs,...(v.encrypted.length?['merqo-doudian-staging-key']:[])]);
 for(const id of required)if(!p.secrets.some(s=>s.sourceId===id))throw Error('备份缺少接入凭据或暂存密钥');
 for(const id of v.refs)SyncCredentialsSchema.parse(JSON.parse(p.secrets.find(s=>s.sourceId===id)!.value));
 if(p.secrets.some(s=>!required.has(s.sourceId)))throw Error('备份包含范围外凭据');
 if(v.encrypted.length){const key=Buffer.from(p.secrets.find(s=>s.sourceId==='merqo-doudian-staging-key')!.value,'base64');if(key.length!==32)throw Error('暂存密钥无效');try{for(const text of v.encrypted){const e=JSON.parse(text);if(e.v!==1)throw Error('version');const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));decipher.setAuthTag(Buffer.from(e.tag,'base64'));const data=Buffer.concat([decipher.update(Buffer.from(e.data,'base64')),decipher.final()]);try{if(!Array.isArray(JSON.parse(data.toString('utf8'))))throw Error('shape');}finally{data.fill(0);}}}catch{throw Error('备份暂存页解密校验失败');}finally{key.fill(0);}}
 }finally{db.close();}
}
export function captureBackup(retail:string,workspaceId:string,workspaceName:string,secrets:BackupSecret[],expectedConnectionHash:string):Payload {
 if(!existsSync(retail))throw Error('当前工作空间没有经营数据');
 const unknown=readdirSync(retail).filter(n=>n.endsWith('.sqlite')&&!BACKUP_FILES.includes(n as never)&&!n.includes('.backup-v'));if(unknown.length)throw Error('存在未知经营数据库，请升级备份程序');
 const files=BACKUP_FILES.filter(name=>existsSync(join(retail,name)));if(!files.length)throw Error('当前工作空间没有经营数据库');
 if(files.some(n=>lstatSync(join(retail,n)).isSymbolicLink()))throw Error('经营数据库不能是符号链接');
 if(files.reduce((n,f)=>n+lstatSync(join(retail,f)).size,0)>MAX_DATABASE_BYTES)throw Error('当前备份最多支持64MB经营数据库');
 const db=new Database(':memory:');db.exec('PRAGMA busy_timeout=5000');
 try{files.forEach((name,i)=>db.query(`ATTACH DATABASE ? AS d${i}`).run(join(retail,name)));
 return db.transaction(()=>{const list:Payload['files']=[];let size=0;
  files.forEach((name,i)=>{const bytes=db.serialize('d'+i);size+=bytes.length;if(size>MAX_DATABASE_BYTES)throw Error('当前备份最多支持64MB经营数据库');const checked=openImage(bytes);try{checkVersion(checked,name);}finally{checked.close();}list.push({name,data:bytes.toString('base64'),sha256:hash(bytes)});bytes.fill(0);});
  const p=payloadSchema.parse({version:1,id:crypto.randomUUID(),createdAt:Date.now(),workspaceId,workspaceName,files:list,secrets});
  const sync=list.find(f=>f.name==='operations.sqlite.sync.sqlite');let currentHash=hash('[]');if(sync){const d=openImage(Buffer.from(sync.data,'base64'));try{currentHash=syncInventory(d).connectionHash;}finally{d.close();}}
  if(currentHash!==expectedConnectionHash||BACKUP_FILES.some(n=>existsSync(join(retail,n))!==files.includes(n)))throw Error('经营数据或接入配置已变化，请重新备份');validateSecrets(p);return p;
 }).immediate();}finally{db.close();}
}
export function writeBackup(p:Payload,password:string,file:string){
 BackupPassword.parse(password);const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 const plain=Buffer.from(JSON.stringify(p));try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('MerqoBackup:1'));const data=Buffer.concat([cipher.update(plain),cipher.final()]);const archive=JSON.stringify({format:'MerqoBackup',version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});if(Buffer.byteLength(archive)>MAX_ARCHIVE_BYTES)throw Error('备份包超出100MB上限');const temp=join(dirname(file),'.merqo-backup-'+crypto.randomUUID()+'.tmp');try{writeFileSync(temp,archive,{flag:'wx',mode:0o600});renameSync(temp,file);}finally{if(existsSync(temp))unlinkSync(temp);}return backupSummary(p);}finally{plain.fill(0);key.fill(0);}
}
export function readBackup(file:string,password:string,expectedHash?:string):{payload:Payload;fileHash:string}{
 BackupPassword.parse(password);if(lstatSync(file).size>MAX_ARCHIVE_BYTES)throw Error('备份文件超过100MB');const content=readFileSync(file);const fileHash=hash(content);if(expectedHash&&expectedHash!==fileHash)throw Error('备份文件自预览后已变化，请重新预览');let plain:Buffer|undefined,key:Buffer|undefined;
 try{const v=z.strictObject({format:z.literal('MerqoBackup'),version:z.literal(1),salt:z.string(),iv:z.string(),tag:z.string(),data:z.string()}).parse(JSON.parse(content.toString('utf8')));const salt=Buffer.from(v.salt,'base64'),iv=Buffer.from(v.iv,'base64'),tag=Buffer.from(v.tag,'base64');if(salt.length!==16||iv.length!==12||tag.length!==16)throw Error('header');key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('MerqoBackup:1'));decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(Buffer.from(v.data,'base64')),decipher.final()]);const payload=payloadSchema.parse(JSON.parse(plain.toString('utf8')));if(new Set(payload.files.map(f=>f.name)).size!==payload.files.length||backupSummary(payload).bytes>MAX_DATABASE_BYTES)throw Error('files');for(const f of payload.files){const bytes=Buffer.from(f.data,'base64');if(hash(bytes)!==f.sha256)throw Error('digest');const db=openImage(bytes);try{checkVersion(db,f.name);}finally{db.close();}}validateSecrets(payload);return{payload,fileHash};}catch{throw Error('备份密码不正确、文件损坏或格式不受支持');}finally{plain?.fill(0);key?.fill(0);}
}
/** Writes only into a newly created directory. Never replaces an existing workspace. */
export function restoreBackup(p:Payload,target:string){
 mkdirSync(target,{recursive:false});const retail=join(target,'retail');mkdirSync(retail);
 writeFileSync(join(retail,'restored-history.json'),JSON.stringify({version:1,backupId:p.id,originalWorkspaceId:p.workspaceId,restoredAt:Date.now(),executionDisabled:true,ready:false}),{flag:'wx'});
 for(const f of p.files){const db=openImage(Buffer.from(f.data,'base64'));try{
  const tables=new Set(db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name));
  if(f.name.endsWith('.sync.sqlite')){
   if(tables.has('sync_schedule'))db.exec("UPDATE sync_schedule SET json=json_set(json,'$.config.enabled',json('false'))");
   if(tables.has('sync_jobs'))db.exec("UPDATE sync_jobs SET json=json_set(json,'$.status','paused','$.epoch',COALESCE(json_extract(json,'$.epoch'),0)+1,'$.error','从备份恢复，须重新检测连接后手动继续') WHERE json_extract(json,'$.status') IN ('queued','running','retry_wait')");
   if(tables.has('sync_connection'))db.exec("UPDATE sync_connection SET json=json_set(json,'$.check',NULL)");
  }
  if(f.name.endsWith('.checks.sqlite')&&tables.has('check_config'))db.exec("UPDATE check_config SET json=json_set(json,'$.enabled',json('false'))");
  writeFileSync(join(retail,f.name),db.serialize(),{flag:'wx',mode:0o600});
 }finally{db.close();}}
 return backupSummary(p);
}
