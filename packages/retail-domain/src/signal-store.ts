import {freezeSourceMetadata} from './source-provenance';
import type {EvidenceProvenance,SourceMetadataInput} from './source-metadata';
import {readBusinessPolicy} from './policy-store';
import {freezePolicy,policyRuleVersion} from './business-policy';
import type {BusinessPolicy} from './business-policy';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SignalQueries } from './signal-query';
import type { SignalPage, SignalPageInput } from './signal-query';
import { ADS_DEMO, INVENTORY_DEMO, SIGNAL_RULE, calculateSignal, previewSignals, signalKey } from './signals';
import type { SignalBatch, SignalKind, SignalPreview, SignalRecord, SignalRow, SignalSnapshot } from './signals';
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
interface Stored { id: string; kind: SignalKind; source: 'demo' | 'csv'; json: string; batch_json:string; imported_at: string; batch_id: string; hash: string }
export class SignalStore {
  private readonly db: Database;
  private queries?: SignalQueries;
  constructor(private readonly file: string, private readonly readOnly = false) {
    if (!readOnly) mkdirSync(dirname(file), { recursive: true }); this.db = new Database(file, readOnly ? { readonly: true, strict: true } : { create: true, strict: true });
    // Bound the pager cache at ~64 MiB so large indexed writes do not thrash the default ~2 MiB cache.
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA cache_size=-65536');
    if (readOnly) return;
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS signal_batches(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,imported_at TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),UNIQUE(kind,source,hash)) STRICT;
        CREATE TABLE IF NOT EXISTS signal_current(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,row_key TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),batch_id TEXT NOT NULL REFERENCES signal_batches(id),UNIQUE(kind,source,row_key)) STRICT;
        CREATE TABLE IF NOT EXISTS signal_history(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES signal_batches(id),json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE TABLE IF NOT EXISTS signal_rules(version TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;`);
      const definition = JSON.stringify({ decline_percent: 20, lead_buffer_days: 2, windows: 'adjacent_equal', money: 'CNY_minor', missing: 'block', attribution: 'exact_match' });
      this.db.query('INSERT OR IGNORE INTO signal_rules VALUES (?,?)').run(SIGNAL_RULE, definition);
      if (this.db.query<{ json: string }, [string]>('SELECT json FROM signal_rules WHERE version=?').get(SIGNAL_RULE)?.json !== definition) throw new Error('规则定义变化时必须提升版本');
    } catch (error) { this.db.close(); throw error; }
  }
  private policy():BusinessPolicy{return readBusinessPolicy(this.file.endsWith('.signals.sqlite')?this.file.slice(0,-'.signals.sqlite'.length):this.file);}
  close(): void { this.db.close(); }
  page(input: SignalPageInput = {}): SignalPage {
    if (this.readOnly) throw new Error('只读数据连接不创建分页投影');
    this.queries ??= new SignalQueries(this.db, () => {const policy=this.policy();return{...this.metadata(policy),records:this.records(undefined,undefined,policy)};},()=>policyRuleVersion(SIGNAL_RULE,this.policy().revision));
    return this.queries.page(input);
  }
  private metadata(policy=this.policy()): Omit<SignalSnapshot, 'records'> {
    return { batches: this.db.query<{ json: string }, []>('SELECT json FROM signal_batches ORDER BY imported_at DESC,id DESC LIMIT 50').all().map(r => JSON.parse(r.json) as SignalBatch), ruleVersion: policyRuleVersion(SIGNAL_RULE,policy.revision) };
  }
  *records(source?: 'demo' | 'csv', scope?: import('./related-evidence').EvidenceScope, policy=this.policy()): Generator<SignalRecord> {
    // A cursor and its specification-conflict lookup must see the same source snapshot.
    const ownTransaction = !this.db.inTransaction;
    if (ownTransaction) this.db.exec('BEGIN DEFERRED');
    try {
      const conflicts = new Set(this.db.query<{ identity: string }, string[]>(`SELECT json_array(source,json_extract(json,'$.shop_id'),json_extract(json,'$.channel'),json_extract(json,'$.sku_id')) AS identity FROM signal_current WHERE kind='inventory'${source ? ' AND source=?' : ''} GROUP BY source,json_extract(json,'$.shop_id'),json_extract(json,'$.channel'),json_extract(json,'$.sku_id') HAVING count(DISTINCT json_extract(json,'$.spec'))>1`).all(...(source ? [source] : [])).map(r => r.identity));
      // Own the statement: early iterator cancellation must not leave a finalized statement in Bun's query cache.
      const clauses = [...(source ? ['r.source=?'] : []), ...(scope ? ["json_extract(r.json,'$.shop_id')=?", "json_extract(r.json,'$.channel')=?", "json_extract(r.json,'$.sku_id')=?", "json_extract(r.json,'$.date')=?"] : [])];
      const cursor = this.db.prepare<Stored, string[]>(`SELECT r.id,r.kind,r.source,r.json,r.batch_id,b.imported_at,b.hash,b.json AS batch_json FROM signal_current r JOIN signal_batches b ON r.batch_id=b.id${clauses.length ? ' WHERE '+clauses.join(' AND ') : ''} ORDER BY r.kind,r.source,r.row_key`);
      const metadata=new Map<string,EvidenceProvenance|undefined>();
      try {
        for (const stored of cursor.iterate(...(source ? [source] : []), ...(scope ? [scope.row.shop_id,scope.row.channel,scope.row.sku_id,scope.row.date] : []))) {
          if(!metadata.has(stored.batch_id))metadata.set(stored.batch_id,(JSON.parse(stored.batch_json) as SignalBatch).provenance);
          const row = JSON.parse(stored.json) as SignalRow;
          const frozen=freezePolicy(policy,row.shop_id);const metrics = calculateSignal(stored.kind, row,policy.revision?frozen.settings:undefined);
          if (stored.kind === 'inventory' && conflicts.has(JSON.stringify([stored.source, row.shop_id, row.channel, row.sku_id]))) metrics.issues.push('同店铺同渠道 SKU 规格冲突，禁止合并判断');
          yield { ...(metadata.get(stored.batch_id)?{provenance:metadata.get(stored.batch_id)!}:{}), ...(policy.revision?{policy:frozen}:{}), id: stored.id, kind: stored.kind, source: stored.source, row, metrics, status: metrics.issues.length ? 'needs_evidence' : metrics.flags.length ? 'warning' : 'normal', importedAt: stored.imported_at, batchId: stored.batch_id, hash: stored.hash, ruleVersion: policyRuleVersion(SIGNAL_RULE,policy.revision) };
        }
      } finally { cursor.finalize(); }
    } finally { if (ownTransaction) this.db.exec('ROLLBACK'); }
  }
  snapshot(): SignalSnapshot { const policy=this.policy();return { records: [...this.records(undefined,undefined,policy)], ...this.metadata(policy) }; }
  import(kind: SignalKind, csv: string, mapping: Record<string, string> | undefined, source: 'demo' | 'csv', reloadDemo = false, sourceMetadata?:SourceMetadataInput): { data: SignalSnapshot; notice: string; preview: SignalPreview } {
    if (this.readOnly) throw new Error('只读数据连接不允许导入');
    const preview = previewSignals(kind, csv, mapping);
    if (!preview.valid.length) throw new Error('没有有效行，请修正映射和数据');
    if(reloadDemo&&source!=='demo')throw new Error('仅内置合成演示允许重新载入');
    const importedAt=new Date().toISOString();const provenance=freezeSourceMetadata(source,kind,csv,preview.valid,importedAt,sourceMetadata);
    let digest = hash(JSON.stringify({ csv, mapping: preview.mapping, rule: SIGNAL_RULE,...(provenance?{provenance}:{} ) })); let id = `${kind}-${source}-${digest.slice(0, 24)}`;
    let duplicate = false;
    this.db.transaction(() => {
      const exists=this.db.query('SELECT id FROM signal_batches WHERE id=?').get(id);
      if(exists&&!reloadDemo){duplicate=true;return;}
      if(reloadDemo){const rows=this.db.query<{row_key:string;json:string;batch_id:string},[string,string]>('SELECT row_key,json,batch_id FROM signal_current WHERE kind=? AND source=?').all(kind,source);const byKey=new Map(rows.map(r=>[r.row_key,r]));
        if(preview.valid.every(row=>byKey.get(signalKey(kind,row))?.json===JSON.stringify(row))){duplicate=true;return;}
        if(exists){const previous=preview.valid.map(row=>[signalKey(kind,row),byKey.get(signalKey(kind,row))?.batch_id??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));digest=hash(JSON.stringify({contentHash:digest,previous}));id=`${kind}-demo-${digest.slice(0,24)}`;}
      }
      let count = this.db.query<{ n: number }, [string, string]>('SELECT count(*) AS n FROM signal_current WHERE kind=? AND source=?').get(kind, source)!.n;
      if (count + preview.valid.length > 100000) {
        const existing = this.db.query('SELECT 1 FROM signal_current WHERE kind=? AND source=? AND row_key=?');
        for (const row of preview.valid) if (!existing.get(kind, source, signalKey(kind, row)) && ++count > 100000) throw new Error('每类来源最多保留 100,000 条当前快照');
      }
      const batch: SignalBatch = { ...(provenance?{provenance}:{}), ruleVersion: SIGNAL_RULE, id, kind, source, importedAt, accepted: preview.valid.length, rejected: preview.rejected.length, hash: digest, errors: preview.rejected };
      this.db.query('INSERT INTO signal_batches VALUES (?,?,?,?,?,?)').run(id, kind, source, batch.importedAt, digest, JSON.stringify(batch));
      const upsert = this.db.query('INSERT INTO signal_current VALUES (?,?,?,?,?,?) ON CONFLICT(kind,source,row_key) DO UPDATE SET id=excluded.id,json=excluded.json,batch_id=excluded.batch_id');
      const history = this.db.query('INSERT INTO signal_history VALUES (?,?,?)');
      for (const row of preview.valid) {
        const key = signalKey(kind, row); const rowId = hash(id + key).slice(0, 24); const json = JSON.stringify(row);
        upsert.run(rowId, kind, source, key, json, id);
        history.run(rowId, id, json);
      }
    }).immediate();
    return { data: this.page({ kind, source }), notice: duplicate ? reloadDemo?'内置演示样例已就绪，内容相同，未重复写入；合成演示不受24小时限制':'此文件与映射已导入，未重复写入' : `已导入 ${preview.valid.length} 条，隔离 ${preview.rejected.length} 条；历史快照保留`, preview: { ...preview, validCount: preview.valid.length, valid: preview.valid.slice(0, 30) } };
  }
  demo(): SignalSnapshot { this.import('inventory', INVENTORY_DEMO, undefined, 'demo', true); this.import('ads', ADS_DEMO, undefined, 'demo', true); return this.page({ source: 'demo' }); }
}
