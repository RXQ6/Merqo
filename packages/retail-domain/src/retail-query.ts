import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { EvidenceRecord, Snapshot } from './operations';

export const RetailPageSchema = z.strictObject({
  source: z.enum(['demo', 'csv']).optional(), shop: z.string().max(100).optional(), channel: z.string().max(80).optional(), date: z.string().max(10).optional(),
  status: z.enum(['all', 'normal', 'low_margin', 'needs_evidence', 'anomalies']).default('all'), search: z.string().max(200).default(''),
  offset: z.number().int().min(0).max(200000).default(0), limit: z.number().int().min(1).max(200).default(30),
});
export type RetailPageInput = z.input<typeof RetailPageSchema>;
export interface RetailPagination {
  total: number; offset: number; limit: number;
  summary: { total: number; known: number; warning: number; missing: number; revenueMinor: string; profitMinor: string };
  facets: { shops: string[]; channels: string[]; dates: string[] };
}

/** Rebuildable read projection. Source/history remain authoritative; triggers fence every source mutation. */
export class RetailQueries {
  constructor(private readonly db: Database, private readonly load: () => Snapshot,private readonly currentRuleVersion:()=>string=()=>'' ) {
    const hadBatchInvalidation = !!db.query('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'retail_query_retail_batches_update');
    db.exec(`CREATE TABLE IF NOT EXISTS retail_query_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),dirty INTEGER NOT NULL,base_json TEXT);
      INSERT OR IGNORE INTO retail_query_meta VALUES(1,1,NULL);
      CREATE TABLE IF NOT EXISTS retail_query_records(id TEXT PRIMARY KEY,source TEXT NOT NULL,shop TEXT NOT NULL,channel TEXT NOT NULL,date TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,search TEXT NOT NULL,revenue TEXT,profit TEXT,evidence_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS retail_query_order ON retail_query_records(source,shop,date DESC,sku,id);
      CREATE INDEX IF NOT EXISTS retail_query_scope ON retail_query_records(source,shop,channel,date,status);
      CREATE INDEX IF NOT EXISTS retail_query_metrics ON retail_query_records(source,shop,channel,date,status,revenue,profit);
      CREATE TRIGGER IF NOT EXISTS retail_query_insert AFTER INSERT ON retail_records BEGIN UPDATE retail_query_meta SET dirty=1 WHERE singleton=1; END;
      CREATE TRIGGER IF NOT EXISTS retail_query_update AFTER UPDATE ON retail_records BEGIN UPDATE retail_query_meta SET dirty=1 WHERE singleton=1; END;
      CREATE TRIGGER IF NOT EXISTS retail_query_delete AFTER DELETE ON retail_records BEGIN UPDATE retail_query_meta SET dirty=1 WHERE singleton=1; END;`);
    // Both evidence JSON and base batch history depend on these tables, not only retail_records.
    for (const table of ['retail_batches', 'retail_batch_rules','retail_batch_provenance'] as const) for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS retail_query_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE retail_query_meta SET dirty=1 WHERE singleton=1; END;`);
    }
    // A projection created by the earlier version may already be stale; invalidate it once on upgrade.
    if (!hadBatchInvalidation) db.query('UPDATE retail_query_meta SET dirty=1 WHERE singleton=1').run();
  }
  private ready(): Omit<Snapshot, 'records'> {
    return this.db.transaction(() => {
      let meta = this.db.query<{ dirty: number; base_json: string | null }, []>('SELECT dirty,base_json FROM retail_query_meta WHERE singleton=1').get()!;
      const version=this.currentRuleVersion();
      if (meta.dirty || !meta.base_json || version&&JSON.parse(meta.base_json).ruleVersion!==version) {
        const { records, ...base } = this.load();
        this.db.exec('DELETE FROM retail_query_records');
        const insert = this.db.query('INSERT INTO retail_query_records VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of records) insert.run(r.id, r.source, r.row.shop_id, r.row.channel, r.row.date, r.row.sku_id, r.status,
          `${r.row.sku_id} ${r.row.product_name} ${r.row.spec}`.toLowerCase(), r.calculation.totalRevenueMinor?.toString() ?? null, r.calculation.totalProfitMinor?.toString() ?? null, JSON.stringify(r));
        const json = JSON.stringify(base);
        this.db.query('UPDATE retail_query_meta SET dirty=0,base_json=? WHERE singleton=1').run(json);
        meta = { dirty: 0, base_json: json };
      }
      return JSON.parse(meta.base_json!) as Omit<Snapshot, 'records'>;
    }).immediate();
  }
  page(input: RetailPageInput = {}): Snapshot {
    const q = RetailPageSchema.parse(input);
    const base = this.ready();
    return this.db.transaction(() => {
      // A writer between ready() and this transaction invalidates the projection; rebuild in this same snapshot.
      if (this.db.query<{ dirty: number }, []>('SELECT dirty FROM retail_query_meta WHERE singleton=1').get()!.dirty) return this.page(input);
      const scope: string[] = [], params: string[] = [];
      for (const [key, value] of [['source', q.source], ['shop', q.shop], ['channel', q.channel], ['date', q.date]] as const) if (value) { scope.push(`${key}=?`); params.push(value); }
      const scopedWhere = scope.length ? ' WHERE ' + scope.join(' AND ') : '';
      const sums = this.db.query<{ status: string; revenue: string | null; profit: string | null }, string[]>(`SELECT status,revenue,profit FROM retail_query_records${scopedWhere}`).all(...params);
      const summary: RetailPagination['summary'] = { total: sums.length, known: 0, warning: 0, missing: 0, revenueMinor: '0', profitMinor: '0' };
      let revenue = 0n, profit = 0n;
      for (const r of sums) {
        if (r.status === 'needs_evidence') summary.missing++;
        else { summary.known++; revenue += BigInt(r.revenue ?? '0'); profit += BigInt(r.profit ?? '0'); }
        if (r.status === 'low_margin') summary.warning++;
      }
      summary.revenueMinor = revenue.toString(); summary.profitMinor = profit.toString();
      const filters = [...scope], args = [...params];
      if (q.status === 'anomalies') filters.push("status!='normal'"); else if (q.status !== 'all') { filters.push('status=?'); args.push(q.status); }
      if (q.search) { filters.push("search LIKE ? ESCAPE '\\'"); args.push('%' + q.search.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'); }
      const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
      const total = this.db.query<{ n: number }, string[]>(`SELECT count(*) AS n FROM retail_query_records${where}`).get(...args)!.n;
      const offset = Math.min(q.offset, Math.max(0, Math.floor((total - 1) / q.limit) * q.limit));
      const rows = this.db.query<{ evidence_json: string }, (string | number)[]>(`SELECT evidence_json FROM retail_query_records${where} ORDER BY source,shop,date DESC,sku,id LIMIT ? OFFSET ?`).all(...args, q.limit, offset);
      const facets = (column: 'shop' | 'channel' | 'date') => this.db.query<{ value: string }, string[]>(`SELECT DISTINCT ${column} AS value FROM retail_query_records${q.source ? ' WHERE source=?' : ''} ORDER BY value`).all(...(q.source ? [q.source] : [])).map(r => r.value);
      return { ...base, records: rows.map(r => JSON.parse(r.evidence_json) as EvidenceRecord), pagination: { total, offset, limit: q.limit, summary, facets: { shops: facets('shop'), channels: facets('channel'), dates: facets('date') } } };
    }).deferred();
  }
  explain(): unknown[] { this.ready(); return this.db.query("EXPLAIN QUERY PLAN SELECT evidence_json FROM retail_query_records WHERE source='csv' AND shop='shop-0' ORDER BY source,shop,date DESC,sku,id LIMIT 30").all(); }
}
