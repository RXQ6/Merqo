/** Bun-only persistence; imported exclusively by the isolated data worker. */
import {freezeSourceMetadata} from './source-provenance';
import type {EvidenceProvenance,SourceMetadataInput} from './source-metadata';
import {readBusinessPolicy} from './policy-store';
import {freezePolicy,policyRuleVersion} from './business-policy';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RetailQueries } from './retail-query';
import type { RetailPageInput } from './retail-query';
import { bundleIdentity, calculate, DEMO_CSV, previewCsv, RowSchema, rowKey, RULE_VERSION } from './operations.ts';
import type { BatchSummary, EvidenceRecord, Preview, RetailReply, RetailRequest, Snapshot } from './operations.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
interface StoredRow { id: string; row_json: string; batch_id: string; source: 'demo' | 'csv'; imported_at: string; snapshot_hash: string }
interface StoredBatch { id: string; source: 'demo' | 'csv'; imported_at: string; accepted: number; rejected: number; hash: string; errors_json: string; rule_version: string }
export class RetailStore {
  private readonly db: Database;
  private queries?: RetailQueries;
  constructor(private readonly file: string, private readonly workspaceName = '当前 Workspace', private readonly readOnly = false) {
    if (!readOnly) mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, readOnly ? { readonly: true, strict: true } : { create: true, strict: true });
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=5000'); return; }
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
      if (version > 2) { throw new Error('数据库版本高于当前程序，禁止降级写入'); }
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
        const definition = JSON.stringify({ threshold_bps: 2000, revenue: 'list_price-coupon-full_reduction+additional_platform_settlement', unknown_cost: 'block', unknown_subsidy: 'block', conflicting_spec: 'block', bundle: 'flat_explicit_components_unique_sku_spec_qty_CNY_cost_sum_equals_pack_cost;missing_or_conflict_block', gift: 'free_per_unit;additional_cost;zero_gift_revenue;discounts_on_main;unknown_or_conflict_block', membership: 'explicit_segment_status;business_date_[from,to);member_price;stackable_or_exclusive;unknown_or_conflict_block', offers: 'retail-offers-v1;exact_scope_date;public_available_only;unknown_blocks;reference_not_sales_price' });
        this.db.query('INSERT OR IGNORE INTO retail_rules (version,definition_json) VALUES (?,?)').run(RULE_VERSION, definition);
        const storedRule = this.db.query<{ definition_json: string }, [string]>('SELECT definition_json FROM retail_rules WHERE version=?').get(RULE_VERSION);
        if (storedRule?.definition_json !== definition) throw new Error('规则定义变化时必须提升规则版本');
        this.db.query('INSERT OR IGNORE INTO retail_batch_rules (batch_id,rule_version) SELECT id,? FROM retail_batches').run(RULE_VERSION);
      }).immediate();
      this.db.exec(`CREATE TABLE IF NOT EXISTS retail_batch_provenance(batch_id TEXT PRIMARY KEY REFERENCES retail_batches(id),json TEXT NOT NULL CHECK(json_valid(json))) STRICT;`);
      this.queries = new RetailQueries(this.db, () => this.snapshot(),()=>policyRuleVersion(RULE_VERSION,readBusinessPolicy(this.file).revision));
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  page(input: RetailPageInput = {}): Snapshot { if (!this.queries) throw new Error('只读连接不允许创建查询投影'); return this.queries.page(input); }
  queryPlan(): unknown[] { if (!this.queries) throw new Error('只读连接不允许创建查询投影'); return this.queries.explain(); }
  snapshot(scope?: import('./related-evidence').EvidenceScope): Snapshot {
    const policy=readBusinessPolicy(this.file);
    const hasMetadata=!!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retail_batch_provenance'").get();
    const metadata=new Map(hasMetadata?this.db.query<{batch_id:string;json:string},[]>('SELECT batch_id,json FROM retail_batch_provenance WHERE batch_id IN (SELECT DISTINCT batch_id FROM retail_records) OR batch_id IN (SELECT id FROM retail_batches ORDER BY imported_at DESC,id DESC LIMIT 50)').all().map(m=>[m.batch_id,JSON.parse(m.json) as EvidenceProvenance]):[]);
    const stored = this.db.query<StoredRow, string[]>(`SELECT r.id,r.row_json,r.batch_id,r.source,b.imported_at,b.hash AS snapshot_hash
      FROM retail_records r JOIN retail_batches b ON b.id=r.batch_id ${scope ? 'WHERE r.source=? AND r.shop_id=? AND r.channel=? AND r.sku_id=?' : ''} ORDER BY r.source,r.shop_id,r.date DESC,r.sku_id`).all(...(scope ? [scope.source,scope.row.shop_id,scope.row.channel,scope.row.sku_id] : []));
    const specs = new Map<string, Set<string>>();
    const parsed = stored.map(record => ({ record, row: RowSchema.parse(JSON.parse(record.row_json)) }));
    for (const { record, row } of parsed) {
      const identity = JSON.stringify([record.source, row.shop_id, row.channel, row.sku_id]);
      if (!specs.has(identity)) specs.set(identity, new Set());
      specs.get(identity)?.add(JSON.stringify([row.spec, bundleIdentity(row)]));
    }
    const records: EvidenceRecord[] = parsed.map(({ record, row }) => {
      const conflict = (specs.get(JSON.stringify([record.source, row.shop_id, row.channel, row.sku_id]))?.size ?? 0) > 1;
      const frozen=freezePolicy(policy,row.shop_id);const calculation = calculate(row, conflict,policy.revision?frozen.settings:undefined);
      const status = calculation.issues.length ? 'needs_evidence' : calculation.marginBps !== null && calculation.marginBps < frozen.settings.marginFloorBps ? 'low_margin' : 'normal';
      return { ...(metadata.get(record.batch_id)?{provenance:metadata.get(record.batch_id)!}:{}), ...(policy.revision?{policy:frozen}:{}), id: record.id, batchId: record.batch_id, source: record.source, importedAt: record.imported_at,
        snapshotHash: record.snapshot_hash, ruleVersion: policyRuleVersion(RULE_VERSION,policy.revision), row, calculation, status, thresholdBps: frozen.settings.marginFloorBps,
        reasons: status === 'needs_evidence' ? calculation.issues : status === 'low_margin' ? [policy.revision?`商品毛利率低于 ${frozen.settings.marginFloorBps/100}% 配置规则阈值`:'商品毛利率低于 20% 演示规则阈值'] : [] };
    });
    const batches: BatchSummary[] = this.db.query<StoredBatch, []>('SELECT b.id,b.source,b.imported_at,b.accepted,b.rejected,b.hash,b.errors_json,r.rule_version FROM retail_batches b JOIN retail_batch_rules r ON r.batch_id=b.id ORDER BY b.imported_at DESC,b.id DESC LIMIT 50').all().map(batch => ({ ...(metadata.get(batch.id)?{provenance:metadata.get(batch.id)!}:{}), id: batch.id, source: batch.source, importedAt: batch.imported_at, accepted: batch.accepted, rejected: batch.rejected, hash: batch.hash, errors: JSON.parse(batch.errors_json) as BatchSummary['errors'], ruleVersion: batch.rule_version }));
    return { workspaceName: this.workspaceName, records, batches, dbVersion: 2, ruleVersion: policyRuleVersion(RULE_VERSION,policy.revision), thresholdBps: policy.defaultSettings.marginFloorBps };
  }
  import(csv: string, mapping: Record<string, string> | undefined, source: 'demo' | 'csv', reloadDemo = false, sourceMetadata?:SourceMetadataInput): { snapshot: Snapshot; notice: string; preview: Preview } {
    if (this.readOnly) throw new Error('只读数据连接不允许导入');
    const preview = previewCsv(csv, mapping);
    if (!preview.valid.length) throw new Error('没有可导入的有效数据，请检查字段映射和错误行');
    if(reloadDemo&&source!=='demo')throw new Error('仅内置合成演示允许重新载入');
    const imported=new Date().toISOString();const provenance=freezeSourceMetadata(source,'margin',csv,preview.valid,imported,sourceMetadata);
    let digest = hash(JSON.stringify({ csv, mapping: preview.mapping,...(provenance?{provenance}:{} ) }));
    let id = `${source}-${digest.slice(0, 20)}`;
    let duplicate = false;
    this.db.transaction(() => {
      const exists = this.db.query<{ id: string }, [string]>('SELECT id FROM retail_batches WHERE id=?').get(id);
      if (exists && !reloadDemo) { duplicate = true; return; }
      if(reloadDemo){
        const rows=this.db.query<{row_key:string;row_json:string;batch_id:string},[string]>('SELECT row_key,row_json,batch_id FROM retail_records WHERE source=?').all(source);const byKey=new Map(rows.map(r=>[r.row_key,r]));
        if(preview.valid.every(row=>byKey.get(rowKey(row))?.row_json===JSON.stringify(row))){duplicate=true;return;}
        if(exists){const previous=preview.valid.map(row=>[rowKey(row),byKey.get(rowKey(row))?.batch_id??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));digest=hash(JSON.stringify({contentHash:digest,previous}));id=`demo-${digest.slice(0,20)}`;}
      }
      const current = this.db.query<{ row_key: string }, [string]>('SELECT row_key FROM retail_records WHERE source=?').all(source);
      if (new Set([...current.map(record => record.row_key), ...preview.valid.map(rowKey)]).size > 100000) throw new Error('每类来源最多保留 100,000 条当前记录，请缩小导入范围');
      this.db.query('INSERT INTO retail_batches (id,source,imported_at,accepted,rejected,hash,errors_json) VALUES (?,?,?,?,?,?,?)').run(id, source, imported, preview.valid.length, preview.rejected.length, digest, JSON.stringify(preview.rejected));
      if(provenance)this.db.query('INSERT INTO retail_batch_provenance VALUES(?,?)').run(id,JSON.stringify(provenance));
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
    if (duplicate) return { snapshot: this.page(), notice: reloadDemo?'内置演示样例已就绪，内容相同，未重复写入；合成演示不受24小时限制':'此文件与映射已导入，未重复写入', preview };
    return { snapshot: this.page(), notice: `已导入 ${preview.valid.length} 条，隔离 ${preview.rejected.length} 条；同业务键的新快照替换当前视图，历史版本保留`, preview };
  }
  request(request: RetailRequest): RetailReply {
    if (request.op === 'signals' || request.op === 'signals_page' || request.op === 'signals_demo' || request.op === 'signals_preview' || request.op === 'signals_import') throw new Error('库存与广告请求应由场景服务处理');
    if (request.op === 'investigate' || request.op === 'investigations') throw new Error('调查请求必须通过调查服务处理');
    if (request.op === 'preview') { const preview = previewCsv(request.csv, request.mapping); return { ok: true, kind: 'preview', data: { ...preview, validCount: preview.valid.length, valid: preview.valid.slice(0, 30) } }; }
    if (request.op === 'snapshot') { const { op: _op, ...input } = request; return { ok: true, kind: 'snapshot', data: this.page(input) }; }
    if (request.op !== 'demo' && request.op !== 'import') throw new Error('请求必须由调查或决策服务处理');
    const result = request.op === 'demo' ? this.import(DEMO_CSV, undefined, 'demo', true) : this.import(request.csv, request.mapping, 'csv',false,request.sourceMetadata);
    return { ok: true, kind: 'snapshot', data: result.snapshot, notice: result.notice };
  }
}
