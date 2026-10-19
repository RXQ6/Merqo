import {Database} from 'bun:sqlite';import {existsSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {CatalogUpdateSchema,emptyCatalog,mappingOverlap} from './catalog';import type {CatalogView,CatalogSnapshot} from './catalog';import type {z} from 'zod';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function current(db:Database):CatalogSnapshot{const row=db.query<{json:string;hash:string},[]>('SELECT json,hash FROM catalog_history ORDER BY revision DESC LIMIT 1').get();if(!row)return emptyCatalog();if(digest(row.json)!==row.hash)throw Error('商品映射摘要不一致');return JSON.parse(row.json) as CatalogSnapshot;}
export function readCatalog(base:string):CatalogSnapshot{const file=base+'.catalog.sqlite';if(!existsSync(file))return emptyCatalog();const db=new Database(file,{readonly:true,strict:true});try{db.exec('PRAGMA busy_timeout=5000');return current(db);}finally{db.close();}}
export class CatalogStore{
 private readonly db:Database;
 constructor(base:string){mkdirSync(dirname(base),{recursive:true});this.db=new Database(base+'.catalog.sqlite',{create:true,strict:true});this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS catalog_history(revision INTEGER PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json)),hash TEXT NOT NULL) STRICT;CREATE TRIGGER IF NOT EXISTS catalog_immutable_update BEFORE UPDATE ON catalog_history BEGIN SELECT RAISE(ABORT,'immutable catalog');END;CREATE TRIGGER IF NOT EXISTS catalog_immutable_delete BEFORE DELETE ON catalog_history BEGIN SELECT RAISE(ABORT,'immutable catalog');END;`);}
 close(){this.db.close();}
 view():CatalogView{return{current:current(this.db),history:this.db.query<{json:string},[]>('SELECT json FROM catalog_history ORDER BY revision DESC LIMIT 50').all().map(r=>{const v=JSON.parse(r.json) as CatalogSnapshot;return{revision:v.revision,at:v.at,reason:v.reason};})};}
 update(input:z.infer<typeof CatalogUpdateSchema>,actor:string):CatalogView{
  if(actor!=='local-simulation-admin')throw Error('商品映射仅允许本地模拟管理员维护');const r=CatalogUpdateSchema.parse(input);
  return this.db.transaction(()=>{const old=current(this.db);if(old.revision!==r.expectedRevision)throw Error('商品映射版本已变化，请刷新');if(r.entry.id&&!old.entries.some(e=>e.id===r.entry.id))throw Error('待修改映射不存在');const entry={...r.entry,id:r.entry.id??randomUUID()};const entries=[...old.entries.filter(e=>e.id!==entry.id),entry];if(entries.length>1000)throw Error('最多保留1000条商品映射，请停用并修改既有映射');if(entries.some(e=>e.id!==entry.id&&mappingOverlap(e,entry)))throw Error('映射输入身份、活动范围和有效日期重叠，不能猜测商品');const next:CatalogSnapshot={revision:old.revision+1,entries,at:new Date().toISOString(),reason:r.reason,actor};const json=JSON.stringify(next);this.db.query('INSERT INTO catalog_history VALUES(?,?,?)').run(next.revision,json,digest(json));return this.view();}).immediate();
 }
}
