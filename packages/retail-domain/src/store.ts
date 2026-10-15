/** Bun-only persistence; imported exclusively by the isolated data worker. */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { calculate, DEMO_CSV, previewCsv, RowSchema, rowKey, RULE_VERSION } from './operations.ts';
import type { BatchSummary, EvidenceRecord, Preview, RetailReply, RetailRequest, Snapshot } from './operations.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
interface StoredRow { id: string; row_json: string; batch_id: string; source: 'demo' | 'csv'; imported_at: string; snapshot_hash: string }
interface StoredBatch { id: string; source: 'demo' | 'csv'; imported_at: string; accepted: number; rejected: number; hash: string; errors_json: string; rule_version: string }
export class RetailStore {
  private readonly db: Database;
  constructor(file: string, private readonly workspaceName = '当前 Workspace') {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    if (version > 2) { this.db.close(); throw new Error('数据库版本高于当前程序，禁止降级写入'); }
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS retail_batches (
        id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('demo','csv')), imported_at TEXT NOT NULL,
        accepted INTEGER NOT NULL, rejected INTEGER NOT NULL, hash TEXT NOT NULL, errors_json TEXT NOT NULL CHECK(json_valid(errors_json)), UNIQUE(source,hash)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retail_records (
        id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('demo','csv')), row_key TEXT NOT NULL,
        shop_id TEXT NOT NULL, channel TEXT NOT NULL, date TEXT NOT NULL, sku_id TEXT NOT NULL,
        row_json TEXT NOT NULL CHECK(json_valid(row_json)), batch_id TEXT NOT NULL REFERENCES retail_batches(id), UNIQUE(source,row_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retail_records_scope ON retail_records(source,shop_id,channel,date,sku_id);
      CREATE TABLE IF NOT EXISTS retail_row_history (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES retail_batches(id), row_json TEXT NOT NULL CHECK(json_valid(row_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retail_rules (
        version TEXT PRIMARY KEY, definition_json TEXT NOT NULL CHECK(json_valid(definition_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retail_batch_rules (
        batch_id TEXT PRIMARY KEY REFERENCES retail_batches(id), rule_version TEXT NOT NULL REFERENCES retail_rules(version)
      ) STRICT;
      PRAGMA user_version=2;`);
      const definition = JSON.stringify({ threshold_bps: 2000, revenue: 'list_price-coupon-full_reduction+additional_platform_settlement', unknown_cost: 'block', unknown_subsidy: 'block', conflicting_spec: 'block' });
      this.db.query('INSERT OR IGNORE INTO retail_rules (version,definition_json) VALUES (?,?)').run(RULE_VERSION, definition);
      const storedRule = this.db.query<{ definition_json: string }, [string]>('SELECT definition_json FROM retail_rules WHERE version=?').get(RULE_VERSION);
      if (storedRule?.definition_json !== definition) throw new Error('规则定义变化时必须提升规则版本');
      this.db.query('INSERT OR IGNORE INTO retail_batch_rules (batch_id,rule_version) SELECT id,? FROM retail_batches').run(RULE_VERSION);
    })();
  }
  close(): void { this.db.close(); }
  snapshot(): Snapshot {
    const stored = this.db.query<StoredRow, []>(`SELECT r.id,r.row_json,r.batch_id,r.source,b.imported_at,b.hash AS snapshot_hash
      FROM retail_records r JOIN retail_batches b ON b.id=r.batch_id ORDER BY r.source,r.shop_id,r.date DESC,r.sku_id`).all();
    const specs = new Map<string, Set<string>>();
    const parsed = stored.map(record => ({ record, row: RowSchema.parse(JSON.parse(record.row_json)) }));
    for (const { record, row } of parsed) {
      const identity = JSON.stringify([record.source, row.shop_id, row.channel, row.sku_id]);
      if (!specs.has(identity)) specs.set(identity, new Set());
      specs.get(identity)?.add(row.spec);
    }
    const records: EvidenceRecord[] = parsed.map(({ record, row }) => {
      const conflict = (specs.get(JSON.stringify([record.source, row.shop_id, row.channel, row.sku_id]))?.size ?? 0) > 1;
      const calculation = calculate(row, conflict);
      const status = calculation.issues.length ? 'needs_evidence' : calculation.marginBps !== null && calculation.marginBps < 2000 ? 'low_margin' : 'normal';
      return { id: record.id, batchId: record.batch_id, source: record.source, importedAt: record.imported_at,
        snapshotHash: record.snapshot_hash, ruleVersion: RULE_VERSION, row, calculation, status, thresholdBps: 2000,
        reasons: status === 'needs_evidence' ? calculation.issues : status === 'low_margin' ? ['商品毛利率低于 20% 演示规则阈值'] : [] };
    });
    const batches: BatchSummary[] = this.db.query<StoredBatch, []>('SELECT b.id,b.source,b.imported_at,b.accepted,b.rejected,b.hash,b.errors_json,r.rule_version FROM retail_batches b JOIN retail_batch_rules r ON r.batch_id=b.id ORDER BY b.imported_at DESC,b.id DESC LIMIT 50').all().map(batch => ({ id: batch.id, source: batch.source, importedAt: batch.imported_at, accepted: batch.accepted, rejected: batch.rejected, hash: batch.hash, errors: JSON.parse(batch.errors_json) as BatchSummary['errors'], ruleVersion: batch.rule_version }));
    return { workspaceName: this.workspaceName, records, batches, dbVersion: 2, ruleVersion: RULE_VERSION, thresholdBps: 2000 };
  }
  import(csv: string, mapping: Record<string, string> | undefined, source: 'demo' | 'csv'): { snapshot: Snapshot; notice: string; preview: Preview } {
    const preview = previewCsv(csv, mapping);
    if (!preview.valid.length) throw new Error('没有可导入的有效数据，请检查字段映射和错误行');
    const digest = hash(JSON.stringify({ csv, mapping: preview.mapping }));
    const id = `${source}-${digest.slice(0, 20)}`;
    let duplicate = false;
    const imported = new Date().toISOString();
    this.db.transaction(() => {
      const exists = this.db.query<{ id: string }, [string]>('SELECT id FROM retail_batches WHERE id=?').get(id);
      if (exists) { duplicate = true; return; }
      const current = this.db.query<{ row_key: string }, [string]>('SELECT row_key FROM retail_records WHERE source=?').all(source);
      if (new Set([...current.map(record => record.row_key), ...preview.valid.map(rowKey)]).size > 10000) throw new Error('每类数据最多保留 10,000 条当前记录，请缩小导入范围');
      this.db.query('INSERT INTO retail_batches (id,source,imported_at,accepted,rejected,hash,errors_json) VALUES (?,?,?,?,?,?,?)').run(id, source, imported, preview.valid.length, preview.rejected.length, digest, JSON.stringify(preview.rejected));
      this.db.query('INSERT INTO retail_batch_rules (batch_id,rule_version) VALUES (?,?)').run(id, RULE_VERSION);
      const write = this.db.query(`INSERT INTO retail_records (id,source,row_key,shop_id,channel,date,sku_id,row_json,batch_id) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source,row_key) DO UPDATE SET id=excluded.id,row_json=excluded.row_json,batch_id=excluded.batch_id`);
      const history = this.db.query('INSERT INTO retail_row_history (id,batch_id,row_json) VALUES (?,?,?)');
      for (const row of preview.valid) {
        const key = rowKey(row), rowId = hash(id + key).slice(0, 24), json = JSON.stringify(row);
        write.run(rowId, source, key, row.shop_id, row.channel, row.date, row.sku_id, json, id);
        history.run(rowId, id, json);
      }
    }).immediate();
    if (duplicate) return { snapshot: this.snapshot(), notice: '此文件与映射已导入，未重复写入', preview };
    return { snapshot: this.snapshot(), notice: `已导入 ${preview.valid.length} 条，隔离 ${preview.rejected.length} 条；同业务键的新快照替换当前视图，历史版本保留`, preview };
  }
  request(request: RetailRequest): RetailReply {
    if (request.op === 'preview') return { ok: true, kind: 'preview', data: previewCsv(request.csv, request.mapping) };
    if (request.op === 'snapshot') return { ok: true, kind: 'snapshot', data: this.snapshot() };
    const result = request.op === 'demo' ? this.import(DEMO_CSV, undefined, 'demo') : this.import(request.csv, request.mapping, 'csv');
    return { ok: true, kind: 'snapshot', data: result.snapshot, notice: result.notice };
  }
}
