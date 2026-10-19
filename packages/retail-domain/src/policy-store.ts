import {Database} from 'bun:sqlite';
import {existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {PolicyDocumentSchema,PolicyUpdateSchema,initialPolicy} from './business-policy';
import type {BusinessPolicy,PolicyView} from './business-policy';
import type {z} from 'zod';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
interface Stored {revision:number;json:string;hash:string}
function decode(row:Stored):BusinessPolicy{if(hash(row.json)!==row.hash)throw new Error('经营规则配置摘要不一致');const policy=PolicyDocumentSchema.parse(JSON.parse(row.json));if(policy.revision!==row.revision)throw new Error('经营规则配置版本不一致');return policy;}
/** Missing policy files preserve the original rules without creating files on read-only paths. */
export function readBusinessPolicy(baseFile:string):BusinessPolicy{
 const file=baseFile+'.policy.sqlite';if(!existsSync(file))return initialPolicy();
 const db=new Database(file,{readonly:true,strict:true});try{db.exec('PRAGMA busy_timeout=5000');const row=db.query<Stored,[]>('SELECT revision,json,hash FROM policy_history ORDER BY revision DESC LIMIT 1').get();return row?decode(row):initialPolicy();}finally{db.close();}
}
export class PolicyStore{
 private db:Database;
 constructor(baseFile:string){mkdirSync(dirname(baseFile),{recursive:true});this.db=new Database(baseFile+'.policy.sqlite',{create:true,strict:true});this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS policy_history(revision INTEGER PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json)),hash TEXT NOT NULL) STRICT;CREATE TRIGGER IF NOT EXISTS policy_no_update BEFORE UPDATE ON policy_history BEGIN SELECT RAISE(ABORT,'policy history is immutable');END;CREATE TRIGGER IF NOT EXISTS policy_no_delete BEFORE DELETE ON policy_history BEGIN SELECT RAISE(ABORT,'policy history is immutable');END;`);}
 close(){this.db.close();}
 view():PolicyView{const history=this.db.query<Stored,[]>('SELECT revision,json,hash FROM policy_history ORDER BY revision DESC LIMIT 50').all().map(decode);return{current:history[0]??initialPolicy(),history};}
 update(input:z.infer<typeof PolicyUpdateSchema>,actor:string):PolicyView{
  const request=PolicyUpdateSchema.parse(input);if(actor!=='local-simulation-admin')throw new Error('缺少服务端本地模拟管理员角色');
  return this.db.transaction(()=>{const prior=this.view().current;if(prior.revision!==request.expectedRevision)throw new Error('规则版本已变化，请刷新后重新确认');
   const policy:BusinessPolicy={...prior,revision:prior.revision+1,at:new Date().toISOString(),reason:request.reason,actor:'local-simulation-admin',defaultSettings:request.shopId===null?request.settings:prior.defaultSettings,shops:request.shopId===null?prior.shops:[...prior.shops.filter(s=>s.shopId!==request.shopId),{shopId:request.shopId,settings:request.settings}].sort((a,b)=>a.shopId.localeCompare(b.shopId))};
   PolicyDocumentSchema.parse(policy);const json=JSON.stringify(policy);this.db.query('INSERT INTO policy_history VALUES(?,?,?)').run(policy.revision,json,hash(json));return this.view();
  }).immediate();
 }
}
