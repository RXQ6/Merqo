import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADS_DEMO, INVENTORY_DEMO, SIGNAL_RULE, calculateSignal, previewSignals, signalKey } from './signals';
import type { SignalBatch, SignalKind, SignalPreview, SignalRecord, SignalRow, SignalSnapshot, InventoryRow } from './signals';
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
interface Stored { id: string; kind: SignalKind; source: 'demo' | 'csv'; json: string; imported_at: string; batch_id: string; hash: string }
export class SignalStore {
  private readonly db: Database;
  constructor(file: string, private readonly readOnly = false) {
    if (!readOnly) mkdirSync(dirname(file), { recursive: true }); this.db = new Database(file, readOnly ? { readonly: true, strict: true } : { create: true, strict: true });
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=5000'); return; }
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
  close(): void { this.db.close(); }
  snapshot(): SignalSnapshot {
    const rows = this.db.query<Stored, []>('SELECT r.id,r.kind,r.source,r.json,r.batch_id,b.imported_at,b.hash FROM signal_current r JOIN signal_batches b ON r.batch_id=b.id ORDER BY r.kind,r.source,r.row_key').all();
    const specs = new Map<string, Set<string>>();
    const parsed = rows.map(s => ({ stored: s, row: JSON.parse(s.json) as SignalRow }));
    for (const { stored, row } of parsed) if (stored.kind === 'inventory') {
      const key = JSON.stringify([stored.source, row.shop_id, row.channel, row.sku_id]);
      const values = specs.get(key) ?? new Set<string>(); values.add((row as InventoryRow).spec); specs.set(key, values);
    }
    const records: SignalRecord[] = parsed.map(({ stored, row }) => {
      const metrics = calculateSignal(stored.kind, row);
      if (stored.kind === 'inventory' && (specs.get(JSON.stringify([stored.source, row.shop_id, row.channel, row.sku_id]))?.size ?? 0) > 1) metrics.issues.push('同店铺同渠道 SKU 规格冲突，禁止合并判断');
      return { id: stored.id, kind: stored.kind, source: stored.source, row, metrics, status: metrics.issues.length ? 'needs_evidence' : metrics.flags.length ? 'warning' : 'normal', importedAt: stored.imported_at, batchId: stored.batch_id, hash: stored.hash, ruleVersion: SIGNAL_RULE };
    });
    return { records, batches: this.db.query<{ json: string }, []>('SELECT json FROM signal_batches ORDER BY imported_at DESC,id DESC LIMIT 50').all().map(r => JSON.parse(r.json) as SignalBatch), ruleVersion: SIGNAL_RULE };
  }
  import(kind: SignalKind, csv: string, mapping: Record<string, string> | undefined, source: 'demo' | 'csv', reloadDemo = false): { data: SignalSnapshot; notice: string; preview: SignalPreview } {
    if (this.readOnly) throw new Error('只读数据连接不允许导入');
    const preview = previewSignals(kind, csv, mapping);
    if (!preview.valid.length) throw new Error('没有有效行，请修正映射和数据');
    if(reloadDemo&&source!=='demo')throw new Error('仅内置合成演示允许重新载入');
    let digest = hash(JSON.stringify({ csv, mapping: preview.mapping, rule: SIGNAL_RULE })); let id = `${kind}-${source}-${digest.slice(0, 24)}`;
    let duplicate = false;
    this.db.transaction(() => {
      const exists=this.db.query('SELECT id FROM signal_batches WHERE id=?').get(id);
      if(exists&&!reloadDemo){duplicate=true;return;}
      if(reloadDemo){const rows=this.db.query<{row_key:string;json:string;batch_id:string},[string,string]>('SELECT row_key,json,batch_id FROM signal_current WHERE kind=? AND source=?').all(kind,source);const byKey=new Map(rows.map(r=>[r.row_key,r]));
        if(preview.valid.every(row=>byKey.get(signalKey(kind,row))?.json===JSON.stringify(row))){duplicate=true;return;}
        if(exists){const previous=preview.valid.map(row=>[signalKey(kind,row),byKey.get(signalKey(kind,row))?.batch_id??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));digest=hash(JSON.stringify({contentHash:digest,previous}));id=`${kind}-demo-${digest.slice(0,24)}`;}
      }
      const keys = this.db.query<{ row_key: string }, [string, string]>('SELECT row_key FROM signal_current WHERE kind=? AND source=?').all(kind, source).map(r => r.row_key);
      if (new Set([...keys, ...preview.valid.map(r => signalKey(kind, r))]).size > 10000) throw new Error('每类来源最多保留 10,000 条当前快照');
      const batch: SignalBatch = { ruleVersion: SIGNAL_RULE, id, kind, source, importedAt: new Date().toISOString(), accepted: preview.valid.length, rejected: preview.rejected.length, hash: digest, errors: preview.rejected };
      this.db.query('INSERT INTO signal_batches VALUES (?,?,?,?,?,?)').run(id, kind, source, batch.importedAt, digest, JSON.stringify(batch));
      for (const row of preview.valid) {
        const key = signalKey(kind, row); const rowId = hash(id + key).slice(0, 24); const json = JSON.stringify(row);
        this.db.query('INSERT INTO signal_current VALUES (?,?,?,?,?,?) ON CONFLICT(kind,source,row_key) DO UPDATE SET id=excluded.id,json=excluded.json,batch_id=excluded.batch_id').run(rowId, kind, source, key, json, id);
        this.db.query('INSERT INTO signal_history VALUES (?,?,?)').run(rowId, id, json);
      }
    }).immediate();
    return { data: this.snapshot(), notice: duplicate ? reloadDemo?'内置演示样例已就绪，内容相同，未重复写入；合成演示不受24小时限制':'此文件与映射已导入，未重复写入' : `已导入 ${preview.valid.length} 条，隔离 ${preview.rejected.length} 条；历史快照保留`, preview };
  }
  demo(): SignalSnapshot { this.import('inventory', INVENTORY_DEMO, undefined, 'demo', true); this.import('ads', ADS_DEMO, undefined, 'demo', true); return this.snapshot(); }
}
