import type { Database } from 'bun:sqlite';
import { SIGNAL_RULE } from './signals';
import type { SignalRecord, SignalSnapshot } from './signals';
import { SignalPageSchema } from './signal-page';
import type { SignalCounts, SignalPage, SignalPageInput } from './signal-page';
export { SignalPageSchema } from './signal-page';
export type { SignalPage, SignalPageInput } from './signal-page';
const emptyCounts = (): SignalCounts => ({ total: 0, normal: 0, warning: 0, missing: 0 });

/** Rebuildable projection; existing source records and history remain authoritative. */
export class SignalQueries {
  constructor(private readonly db: Database, private readonly load: () => Omit<SignalSnapshot, 'records'> & { records: Iterable<SignalRecord> },private readonly currentRuleVersion:()=>string=()=>SIGNAL_RULE) {
    db.exec(`CREATE TABLE IF NOT EXISTS signal_query_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),dirty INTEGER NOT NULL,version TEXT NOT NULL,base_json TEXT);
      INSERT OR IGNORE INTO signal_query_meta VALUES(1,1,'',NULL);
      CREATE TABLE IF NOT EXISTS signal_query_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,shop TEXT NOT NULL,channel TEXT NOT NULL,date TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,search TEXT NOT NULL,evidence_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS signal_query_order ON signal_query_records(kind,source,shop,date DESC,sku,id);
      CREATE INDEX IF NOT EXISTS signal_query_scope ON signal_query_records(kind,source,shop,channel,date,status);`);
    for (const table of ['signal_current', 'signal_batches', 'signal_rules'] as const) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS signal_query_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE signal_query_meta SET dirty=1 WHERE singleton=1; END;`);
      }
    }
  }

  page(input: SignalPageInput = {}): SignalPage {
    const q = SignalPageSchema.parse(input);
    // Invalidation check, rebuild, counts and rows share one transaction, including other connections' writes.
    return this.db.transaction(() => {
      const meta = this.db.query<{ dirty: number; version: string; base_json: string | null }, []>('SELECT dirty,version,base_json FROM signal_query_meta WHERE singleton=1').get()!;
      let base: Omit<SignalSnapshot, 'records'>;
      if (meta.dirty || meta.version !== this.currentRuleVersion() || !meta.base_json) {
        const { records, ...snapshotBase } = this.load();
        this.db.exec('DELETE FROM signal_query_records');
        const insert = this.db.query('INSERT INTO signal_query_records VALUES(?,?,?,?,?,?,?,?,?,?)');
        for (const r of records) insert.run(r.id, r.kind, r.source, r.row.shop_id, r.row.channel, r.row.date, r.row.sku_id, r.status, JSON.stringify(r.row).toLowerCase(), JSON.stringify(r));
        base = snapshotBase;
        this.db.query('UPDATE signal_query_meta SET dirty=0,version=?,base_json=? WHERE singleton=1').run(base.ruleVersion, JSON.stringify(base));
      } else base = JSON.parse(meta.base_json) as Omit<SignalSnapshot, 'records'>;
      const scope: string[] = [], params: string[] = [];
      for (const [column, value] of [['kind', q.kind], ['source', q.source], ['shop', q.shop], ['channel', q.channel], ['date', q.date]] as const) {
        if (value) { scope.push(`${column}=?`); params.push(value); }
      }
      const scopedWhere = scope.length ? ' WHERE ' + scope.join(' AND ') : '';
      const summary = { inventory: emptyCounts(), ads: emptyCounts() };
      const counts = this.db.query<{ kind: 'inventory' | 'ads'; status: SignalRecord['status']; n: number }, string[]>(`SELECT kind,status,count(*) AS n FROM signal_query_records${scopedWhere} GROUP BY kind,status`).all(...params);
      for (const row of counts) {
        const count = summary[row.kind]; count.total += row.n;
        count[row.status === 'needs_evidence' ? 'missing' : row.status] += row.n;
      }
      const filters = [...scope], args = [...params];
      if (q.status === 'anomalies') filters.push("status!='normal'");
      else if (q.status !== 'all') { filters.push('status=?'); args.push(q.status); }
      if (q.search) { filters.push("search LIKE ? ESCAPE '\\'"); args.push('%' + q.search.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'); }
      const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
      const total = this.db.query<{ n: number }, string[]>(`SELECT count(*) AS n FROM signal_query_records${where}`).get(...args)!.n;
      const offset = Math.min(q.offset, Math.max(0, Math.floor((total - 1) / q.limit) * q.limit));
      const rows = this.db.query<{ evidence_json: string }, (string | number)[]>(`SELECT evidence_json FROM signal_query_records${where} ORDER BY kind,source,shop,date DESC,sku,id LIMIT ? OFFSET ?`).all(...args, q.limit, offset);
      // Facets cover the source, independent of current page and selected business filters.
      const facets = (column: 'shop' | 'channel' | 'date') => this.db.query<{ value: string }, string[]>(`SELECT DISTINCT ${column} AS value FROM signal_query_records${q.source ? ' WHERE source=?' : ''} ORDER BY value`).all(...(q.source ? [q.source] : [])).map(r => r.value);
      return { ...base, records: rows.map(r => JSON.parse(r.evidence_json) as SignalRecord), pagination: { total, offset, limit: q.limit, summary, facets: { shops: facets('shop'), channels: facets('channel'), dates: facets('date') } } };
    }).immediate();
  }
}
