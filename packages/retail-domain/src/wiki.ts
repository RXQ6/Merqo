import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { businessDigest, businessScope } from './business-identity';
import type { BusinessTask, TaskDetail } from './business-task-contract';
import type { AnyInvestigation } from './investigations';
import type { LibraryItem, BusinessCase } from './workbench-contract';
import { wikiMeta, WikiRequestSchema, WikiSourceFields, type WikiData, type WikiRequest, type WikiSource, type WikiJob, type WikiReference } from './wiki-contract';
type Row = { json: string };
const parse = <T>(r: Row): T => JSON.parse(r.json);
export function installWikiSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS wiki_refs(workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,item_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(workspace_id,run_id,item_id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS wiki_sources(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS wiki_sources_scope ON wiki_sources(workspace_id);
    CREATE TABLE IF NOT EXISTS wiki_jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS wiki_jobs_scope ON wiki_jobs(workspace_id,source_id);
    CREATE TABLE IF NOT EXISTS wiki_recent(workspace_id TEXT NOT NULL,item_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(workspace_id,item_id)) STRICT;`);
}
export function wikiUsable(item: LibraryItem, scope: { scenario: string; shop: string; sku: string; date: string }, source?: WikiSource): boolean {
  const m = wikiMeta(item);
  return !item.archived && m.status === 'published' && (item.scenario === 'all' || item.scenario === scope.scenario) && (!m.shop || m.shop === scope.shop) && (!m.sku || m.sku === scope.sku) && (!m.validFrom || m.validFrom <= scope.date) && (!m.validTo || m.validTo >= scope.date) && (!m.external || (m.external.available && source?.enabled === true && source.state === 'ready'));
}
export class WikiLedger {
  constructor(private db: Database, private workspaceId: string, private task: (id: string) => TaskDetail) {}
  private now() { return new Date().toISOString(); }
  items(): LibraryItem[] { return this.db.query<Row, [string]>('SELECT json FROM wb_library WHERE workspace_id=? ORDER BY json_extract(json,\'$.updatedAt\') DESC,id DESC LIMIT 500').all(this.workspaceId).map(parse<LibraryItem>); }
  private item(id: string, version?: number): LibraryItem {
    const row = this.db.query<Row, [string, string]>('SELECT json FROM wb_library WHERE workspace_id=? AND id=?').get(this.workspaceId, id);
    if (!row) throw Error('知识不存在或不属于当前工作区');
    if (!version) return parse<LibraryItem>(row);
    const historical = this.db.query<Row, [string, number]>('SELECT json FROM wb_library_versions WHERE id=? AND version=?').get(id, version);
    if (!historical) throw Error('知识版本不存在'); return parse<LibraryItem>(historical);
  }
  private write(item: LibraryItem) {
    if (!this.db.query('SELECT id FROM wb_library WHERE id=?').get(item.id) && this.items().length >= 500) throw Error('最多维护500条知识，请维护现有条目');
    this.db.query('INSERT INTO wb_library VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json').run(item.id, this.workspaceId, item.version, JSON.stringify(item));
    this.db.query('INSERT INTO wb_library_versions VALUES(?,?,?)').run(item.id, item.version, JSON.stringify(item));
  }
  private detail(id: string, version?: number): WikiData {
    const item = this.item(id, version), latest = this.item(id);
    const versions = this.db.query<Row, [string]>('SELECT json FROM wb_library_versions WHERE id=? ORDER BY version DESC LIMIT 100').all(id).map(parse<LibraryItem>).map(v => ({ version: v.version, updatedAt: v.updatedAt, title: v.title }));
    const references = this.db.query<Row, [string, string]>('SELECT json FROM wiki_refs WHERE workspace_id=? AND item_id=? ORDER BY version DESC LIMIT 100').all(this.workspaceId, id).map(parse<WikiReference>);
    const taskIds = this.db.query<{ task_id: string }, [string, string]>('SELECT DISTINCT task_id FROM wb_bindings WHERE workspace_id=? AND item_id=? LIMIT 100').all(this.workspaceId, id).map(r => r.task_id);
    const source=this.sources().find(s=>s.id===item.wiki?.external?.sourceId);
    const investigations=this.db.query<Row,[]>('SELECT json FROM investigations ORDER BY json_extract(json,\'$.createdAt\') DESC').all().map(parse<AnyInvestigation>).filter(r=>!!r.report&&wikiUsable(item,businessScope(r.evidence),source)).slice(0,20).map(r=>({id:r.id,label:`${r.evidence.row.shop_id} / ${r.evidence.row.sku_id} · ${r.evidence.row.date}`}));
    return { view: 'wiki_detail', item, latestVersion: latest.version, versions, references, taskIds, investigations };
  }
  private run(id: string): AnyInvestigation {
    const row = this.db.query<Row, [string]>('SELECT json FROM investigations WHERE id=?').get(id); if (!row) throw Error('调查不存在'); return parse<AnyInvestigation>(row);
  }
  references(id: string): WikiReference[] { this.run(id); return this.db.query<Row, [string, string]>('SELECT json FROM wiki_refs WHERE workspace_id=? AND run_id=? ORDER BY version DESC LIMIT 30').all(this.workspaceId, id).map(parse<WikiReference>); }
  sources(): WikiSource[] { return this.db.query<Row, [string]>('SELECT json FROM wiki_sources WHERE workspace_id=?').all(this.workspaceId).map(parse<WikiSource>); }
  source(id: string): WikiSource { const source = this.sources().find(s => s.id === id); if (!source) throw Error('来源不存在'); return source; }
  eligible(scope: BusinessTask['scope']): LibraryItem[] { const sources = new Map(this.sources().map(s => [s.id, s])); return this.items().filter(i => wikiUsable(i, scope, sources.get(i.wiki?.external?.sourceId ?? ''))); }
  private sourceView(): WikiData {
    const jobs = this.db.query<Row, [string]>('SELECT json FROM wiki_jobs WHERE workspace_id=? ORDER BY json_extract(json,\'$.updatedAt\') DESC LIMIT 50').all(this.workspaceId).map(parse<WikiJob>);
    return { view: 'wiki_sources', sources: this.sources().map(({ credentialRef, ...s }) => ({ ...s, hasCredential: !!credentialRef })), jobs: jobs.map(({ plan, ...j }) => ({ ...j, total: plan.length })) };
  }
  private putSource(s: WikiSource) { this.db.query('INSERT INTO wiki_sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(s.id, this.workspaceId, JSON.stringify(s)); }
  private putJob(j: WikiJob) { j.updatedAt = this.now(); this.db.query('INSERT INTO wiki_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(j.id, this.workspaceId, j.sourceId, JSON.stringify(j)); }
  job(id: string): WikiJob { const row = this.db.query<Row, [string, string]>('SELECT json FROM wiki_jobs WHERE workspace_id=? AND id=?').get(this.workspaceId, id); if (!row) throw Error('同步任务不存在'); return parse<WikiJob>(row); }
  private referenceView(investigationId: string): WikiData {
    const r = this.run(investigationId), scope = businessScope(r.evidence);
    const sources = new Map(this.sources().map(s => [s.id, s]));
    const candidates = this.items().filter(i => wikiUsable(i, scope, sources.get(i.wiki?.external?.sourceId ?? ''))).slice(0, 20).map(item => ({ item, reason: `${item.scenario === 'all' ? '通用规则' : '同经营场景'}${item.wiki?.shop ? ' · 同店铺' : ''}${item.wiki?.sku ? ' · 同商品' : ''} · 业务日期在有效范围内` }));
    const references = this.references(investigationId);
    const warnings = references.filter(r => { const m = wikiMeta(this.item(r.item.id)); return m.status !== 'published' || m.external && (!m.external.available || sources.get(m.external.sourceId)?.state !== 'ready'); }).map(r => `「${r.item.title}」当前版本已停用或来源不可用；保留历史引用，不能当作当前有效规则。`);
    return { view: 'wiki_references', candidates, references, warnings };
  }
  handle(input: WikiRequest): WikiData {
    const r = WikiRequestSchema.parse(input);
    switch (r.op) {
      case 'wb_wiki_list': {
        const all = this.items(), query = r.search.toLowerCase();
        const items = all.filter(i => { const m = wikiMeta(i); return (r.status === 'all' ? m.status !== 'deleted' : m.status === r.status) && (r.category === 'all' || m.category === r.category) && (!r.directory || m.directory === r.directory) && `${i.title} ${i.body} ${m.shop} ${m.sku} ${m.directory}`.toLowerCase().includes(query); });
        const recentIds = this.db.query<{ item_id: string }, [string]>('SELECT item_id FROM wiki_recent WHERE workspace_id=? ORDER BY at DESC LIMIT 5').all(this.workspaceId);
        return { view: 'wiki_list', items: items.slice(r.offset, r.offset + 30), total: items.length, offset: r.offset, directories: [...new Set(all.map(i => wikiMeta(i).directory).filter(Boolean))], recent: recentIds.map(r => all.find(i => i.id === r.item_id)).filter((i): i is LibraryItem => !!i && wikiMeta(i).status !== 'deleted'), maintenance: all.filter(i => { const m = wikiMeta(i); return m.status === 'published' && (m.validTo && m.validTo < new Date(Date.now()+8*3600000).toISOString().slice(0,10) || m.external && (!m.external.available || this.sources().find(s => s.id === m.external!.sourceId)?.state !== 'ready')); }).slice(0, 10) };
      }
      case 'wb_wiki_get': { this.item(r.id); this.db.query('INSERT INTO wiki_recent VALUES(?,?,?) ON CONFLICT(workspace_id,item_id) DO UPDATE SET at=excluded.at').run(this.workspaceId, r.id, this.now()); return this.detail(r.id, r.version); }
      case 'wb_wiki_save': {
        const old = r.id ? this.item(r.id) : null; if ((old?.version ?? 0) !== r.expectedVersion) throw Error('知识版本已变化，请刷新后保存'); if (old?.wiki?.external) throw Error('外部同步文档只读，请复制为本地知识后编辑');
        const item: LibraryItem = { id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, kind: old?.kind ?? (r.meta.category === 'method' ? 'method' : 'topic'), title: r.title, body: r.body, scenario: r.scenario, archived: r.meta.status !== 'published', wiki: { ...r.meta, ...(old?.wiki?.caseId ? { caseId: old.wiki.caseId } : {}), ...(old?.wiki?.taskId ? { taskId: old.wiki.taskId } : {}) }, updatedAt: this.now() };
        this.write(item); return this.detail(item.id);
      }
      case 'wb_wiki_revert': { const old = this.item(r.id), historic = this.item(r.id, r.version); if (old.version !== r.expectedVersion) throw Error('知识版本已变化'); if (old.wiki?.external) throw Error('外部文档不能本地回滚'); const item = { ...historic, version: old.version + 1, updatedAt: this.now() }; this.write(item); return this.detail(item.id); }
      case 'wb_wiki_references': return this.referenceView(r.investigationId);
      case 'wb_wiki_reference': {
        const view = this.referenceView(r.investigationId); if (view.view !== 'wiki_references') throw Error('引用范围无效'); const candidate = view.candidates.find(c => c.item.id === r.itemId);
        const item = this.item(r.itemId); if (item.version !== r.expectedVersion) throw Error('知识版本已变化，请重新选择');
        const run = this.run(r.investigationId); const scope = businessScope(run.evidence);
        if (!candidate && !wikiUsable(item, scope, this.sources().find(s => s.id === item.wiki?.external?.sourceId))) throw Error('知识未发布、来源不可用或不适用于本次调查');
        if(view.references.length>=30&&!view.references.some(ref=>ref.item.id===item.id&&ref.item.version===item.version))throw Error('单次调查最多引用30个知识版本');
        const ref: WikiReference = { investigationId: r.investigationId, item, at: this.now() };
        this.db.query('INSERT OR IGNORE INTO wiki_refs VALUES(?,?,?,?,?)').run(this.workspaceId, r.investigationId, item.id, item.version, JSON.stringify(ref)); return this.referenceView(r.investigationId);
      }
      case 'wb_wiki_from_task': { const detail = this.task(r.taskId); if (detail.task.version !== r.expectedVersion || detail.task.status !== 'done') throw Error('请刷新并完成任务后整理知识'); const t = detail.task, old = this.items().find(i => i.wiki?.taskId === t.id); if (old) return this.detail(old.id); const item: LibraryItem = { id: randomUUID(), version: 1, kind: 'method', title: t.title.slice(0, 100), scenario: t.scope.scenario, body: `# 问题与适用范围\n${t.scope.shop} / ${t.scope.sku}\n\n## 原始调查摘要\n${t.evidence.summary.slice(0, 12000)}\n\n## 处理经过\n${detail.events.map(e => e.note).join('\n').slice(0, 20000)}\n\n## 待人工核对\n补充可复用步骤、证据来源和限制。${t.purpose === 'simulation_action' ? '本任务为本地模拟。' : '本任务为人工分析。'}结果不代表真实经营效果。`, archived: true, updatedAt: this.now(), wiki: { category: 'method', status: 'draft', directory: '任务整理', shop: t.scope.shop, sku: t.scope.sku, validFrom: '', validTo: '', taskId: t.id } }; this.write(item); return this.detail(item.id); }
      case 'wb_wiki_from_case': { const row = this.db.query<Row, [string, string]>('SELECT json FROM wb_cases WHERE workspace_id=? AND id=?').get(this.workspaceId, r.id); if (!row) throw Error('案例不存在'); const c = parse<BusinessCase>(row), old = this.items().find(i => i.wiki?.caseId === c.id); if (old) return this.detail(old.id); const item: LibraryItem = { id: randomUUID(), version: 1, kind: 'method', title: c.title.slice(0, 100), scenario: c.task.task.scope.scenario, body: `# 经营案例\n${c.title}\n\n## 可复用经验\n${c.lesson}\n\n## 人工结果声明\n${c.declaredOutcome}\n\n## 原始依据\n案例 ID：${c.id}\n任务 ID：${c.taskId}\n\n## 限制\n${c.limitation}`, archived: true, updatedAt: this.now(), wiki: { category: 'method', status: 'draft', directory: '案例整理', shop: c.task.task.scope.shop, sku: c.task.task.scope.sku, validFrom: '', validTo: '', caseId: c.id } }; this.write(item); return this.detail(item.id); }
      case 'wb_wiki_sources': return this.sourceView();
      default: throw Error('来源操作必须经桌面连接管理执行');
    }
  }
  // Called only by the trusted main/worker protocol, never in RetailRequestSchema.
  internal(input: unknown): unknown {
    const base = z.object({ action: z.enum(['source_save', 'source', 'start', 'document', 'finish', 'fail', 'check', 'job']) }).parse(input);
    const p = input as Record<string, unknown>;
    const sourceId = () => z.string().uuid().parse(p.sourceId);
    if (base.action === 'source_save') {
      const r = z.strictObject({ action: z.literal('source_save'), id: z.string().uuid().optional(), expectedVersion: z.number().int().min(0), config: WikiSourceFields, credentialRef: z.string().uuid().nullable() }).parse(input);
      const old = r.id ? this.source(r.id) : null; if ((old?.version ?? 0) !== r.expectedVersion) throw Error('来源版本已变化');
      if (old && this.db.query("SELECT id FROM wiki_jobs WHERE workspace_id=? AND source_id=? AND json_extract(json,'$.status')='running'").get(this.workspaceId, old.id)) throw Error('同步进行中，请完成或等待失败后修改来源');
      if (!old && this.sources().length >= 20) throw Error('最多20个 Wiki 来源');
      const s: WikiSource = { ...r.config, id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, credentialRef: r.credentialRef, state: r.config.enabled ? 'unchecked' : 'disabled', lastError: null, lastSyncAt: old?.lastSyncAt ?? null, nextSyncAt: null }; this.putSource(s); return this.sourceView();
    }
    if (base.action === 'source') return this.source(sourceId());
    if (base.action === 'job') return this.job(z.string().uuid().parse(p.jobId));
    if (base.action === 'check') { const s = this.source(sourceId()); s.lastError = p.ok === true ? null : '连接或权限检查失败，请核对来源配置和授权'; s.state = p.ok === true ? (s.state==='error'&&s.lastSyncAt?'unchecked':'ready') : 'error'; this.putSource(s); return this.sourceView(); }
    if (base.action === 'start') {
      const s = this.source(sourceId()); if (!s.enabled) throw Error('来源已停用');
      const prior = this.db.query<Row, [string, string]>("SELECT json FROM wiki_jobs WHERE workspace_id=? AND source_id=? ORDER BY json_extract(json,'$.updatedAt') DESC LIMIT 1").get(this.workspaceId, s.id);
      const old = prior ? parse<WikiJob>(prior) : null;
      if (old && old.status !== 'completed' && p.restart === true) { old.status='failed';old.error='已由重新扫描替代';this.putJob(old); }
      if (old && old.status !== 'completed' && old.sourceVersion === s.version && p.restart !== true) { old.status = 'running'; old.error = null; this.putJob(old); return old; }
      const plan = z.array(z.strictObject({ key: z.string().min(1).max(200), title: z.string().min(1).max(100), url: z.string().url().max(1000), token: z.string().max(200).optional(), directory: z.string().max(100) })).max(500).parse(p.plan);
      if (new Set(plan.map(p => p.key)).size !== plan.length) throw Error('来源文档标识重复');
      const job: WikiJob = { id: randomUUID(), sourceId: s.id, sourceVersion: s.version, status: 'running', index: 0, plan, changed: 0, unchanged: 0, skipped: z.number().int().min(0).parse(p.skipped ?? 0), error: null, startedAt: this.now(), updatedAt: this.now() }; this.putJob(job); return job;
    }
    const j = this.job(z.string().uuid().parse(p.jobId)), s = this.source(j.sourceId); if (s.version !== j.sourceVersion || !s.enabled) throw Error('来源配置已变化，本次同步停止');
    if (base.action === 'fail') { j.status = 'failed'; j.error = '同步中断；已保存文档保留，重试从断点继续。请检查网络、目录和阅读权限。'; s.state = 'error'; s.lastError = j.error; this.putJob(j); this.putSource(s); return this.sourceView(); }
    if (j.status !== 'running') throw Error('同步任务不在运行状态');
    if (base.action === 'document') {
      if (z.number().int().parse(p.index) !== j.index || !j.plan[j.index]) throw Error('同步断点已变化');
      const doc = j.plan[j.index]!, body = z.string().trim().min(1).max(60000).parse(p.body), hash = businessDigest([doc.title, body, doc.directory, doc.url, s.scenario]);
      const old = this.items().find(i => i.wiki?.external?.sourceId === s.id && i.wiki.external.key === doc.key);
      if (old?.wiki?.external?.hash === hash && old.wiki.external.available) j.unchanged++;
      else { const item: LibraryItem = { id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, kind: 'topic', title: doc.title, scenario: s.scenario, body, archived: false, updatedAt: this.now(), wiki: { category: 'material', status: 'published', directory: doc.directory, shop: '', sku: '', validFrom: '', validTo: '', external: { sourceId: s.id, key: doc.key, url: doc.url, hash, syncedAt: this.now(), available: true } } }; this.write(item); j.changed++; }
      j.index++; this.putJob(j); return j;
    }
    if (base.action === 'finish') {
      if (j.index !== j.plan.length) throw Error('同步尚未到达末尾');
      const keys = new Set(j.plan.map(d => d.key));
      for (const old of this.items()) if (old.wiki?.external?.sourceId === s.id && old.wiki.external.available && !keys.has(old.wiki.external.key)) this.write({ ...old, version: old.version + 1, archived: true, updatedAt: this.now(), wiki: { ...old.wiki, status: 'retired', external: { ...old.wiki.external, available: false } } });
      j.status = 'completed'; s.state = 'ready'; s.lastError = null; s.lastSyncAt = this.now(); s.nextSyncAt = s.intervalMinutes ? new Date(Date.now() + s.intervalMinutes * 60000).toISOString() : null; this.putJob(j); this.putSource(s); return this.sourceView();
    }
    throw Error('未知同步操作');
  }
}
