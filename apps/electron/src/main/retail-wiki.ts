import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { requestRetailWorker } from './retail-worker';
import { WikiClient, publicWikiUrl, type WikiTransport } from '../../../../packages/retail-domain/src/wiki-client';
import { WikiRequestSchema, type WikiSource, type WikiJob, type WikiRequest, type WikiData } from '../../../../packages/retail-domain/src/wiki-contract';
import type { RetailReply } from '../../../../packages/retail-domain/src/operations';
type Workspace = { rootPath: string; name: string };
const running = new Set<string>();
function publicAddress(address: string) {
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff|2001:db8)/i.test(address);
  const [a, b] = address.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127 || a! >= 224);
}
// Pin DNS results to the validated public addresses. Never follow redirects or forward credentials to a new origin.
export const wikiHttp: WikiTransport = async (value, options = {}) => {
  const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw Error('只支持公开 HTTPS 文档源');
  const addresses = await lookup(url.hostname, { all: true }); if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('文档源必须指向公网地址');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => request.destroy(Error('Wiki 请求超时')), 20000);
    const request = httpsRequest(url, { method: options.method ?? 'GET', headers: options.headers, lookup: (_host, opts, callback) => { const a = addresses[0]!; if (typeof opts === 'object' && opts.all) (callback as Function)(null, addresses); else (callback as Function)(null, a.address, a.family); } }, response => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(Error('Wiki 接口状态异常')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) request.destroy(Error('Wiki 响应过大')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    request.on('error', () => { clearTimeout(timer); reject(Error('Wiki 网络读取失败，请检查连接与权限')); }); if (options.body) request.write(options.body); request.end();
  });
};
async function internal(workspace: Workspace, workspaceId: string, payload: unknown): Promise<unknown> { const r = await requestRetailWorker(workspace, workspaceId, { op: 'wiki_internal', payload }, 'wiki_internal'); if (!r.ok) throw Error(r.error); if (r.kind !== 'workbench') throw Error('Wiki 同步返回无效'); return r.data; }
const key = (workspaceId: string, sourceId: string) => ({ type: 'source_apikey' as const, workspaceId, sourceId });
async function client(workspaceId: string, source: WikiSource) { const secret = source.credentialRef ? await getCredentialManager().get(key(workspaceId, source.credentialRef)) : null; if (source.credentialRef && !secret) throw Error('来源凭据缺失，请重新配置'); return new WikiClient(source, secret?.value ?? null, wikiHttp); }
async function sync(workspace: Workspace, workspaceId: string, id: string, restart: boolean) {
  let job: WikiJob | undefined;
  try {
    const source = await internal(workspace, workspaceId, { action: 'source', sourceId: id }) as WikiSource, api = await client(workspaceId, source);
    // Resume from the durable plan/index without rebuilding a changed remote manifest.
    const view = await requestRetailWorker(workspace, workspaceId, { op: 'wb_wiki_sources' }, 'wb_wiki_sources');
    const prior = view.ok && view.kind === 'workbench' && view.data.view === 'wiki_sources' ? view.data.jobs.find(j => j.sourceId === id && j.status !== 'completed' && j.sourceVersion === source.version) : null;
    const plan = prior && !restart ? { plan: [], skipped: 0 } : await api.plan();
    job = await internal(workspace, workspaceId, { action: 'start', sourceId: id, restart, ...plan }) as WikiJob;
    while (job.index < job.plan.length) { const body = await api.document(job.plan[job.index]!); job = await internal(workspace, workspaceId, { action: 'document', jobId: job.id, index: job.index, body }) as WikiJob; }
    await internal(workspace, workspaceId, { action: 'finish', jobId: job.id });
  } catch { if (job) await internal(workspace, workspaceId, { action: 'fail', jobId: job.id }).catch(() => {}); else await internal(workspace, workspaceId, { action: 'check', sourceId: id, ok: false }).catch(() => {}); }
  finally { running.delete(workspaceId); }
}
export async function handleRetailWiki(workspace: Workspace, workspaceId: string, input: WikiRequest): Promise<RetailReply> {
  const r = WikiRequestSchema.parse(input);
  if (existsSync(join(workspace.rootPath, 'retail/restored-history.json'))) throw Error('恢复工作区的外部同步已锁定；请在正常工作区重新配置来源');
  if (r.op === 'wb_wiki_source_save') {
    if (running.has(workspaceId)) throw Error('Wiki 同步中，请稍后修改来源');
    if (r.config.provider === 'markdown') publicWikiUrl(r.config.endpoint);
    const old = r.id ? await internal(workspace, workspaceId, { action: 'source', sourceId: r.id }) as WikiSource : null;
    let ref = old?.credentialRef ?? null;
    if (old && old.provider !== r.config.provider) throw Error('请新建不同类型的来源');
    if (r.secret) { ref = randomUUID(); await getCredentialManager().set(key(workspaceId, ref), { value: r.secret }); }
    try { const data = await internal(workspace, workspaceId, { action: 'source_save', id: r.id, expectedVersion: r.expectedVersion, config: r.config, credentialRef: ref }) as WikiData; if (r.secret && old?.credentialRef) await getCredentialManager().delete(key(workspaceId, old.credentialRef)); return { ok: true, kind: 'workbench', data }; }
    catch (e) { if (r.secret && ref) await getCredentialManager().delete(key(workspaceId, ref)); throw e; }
  }
  if (r.op === 'wb_wiki_check') {
    if (running.has(workspaceId)) throw Error('Wiki 同步中，请稍后检查');
    let ok = false; try { const s = await internal(workspace, workspaceId, { action: 'source', sourceId: r.id }) as WikiSource; const api = await client(workspaceId, s); const plan = await api.plan(); if (plan.plan[0]) await api.document(plan.plan[0]); ok = true; } catch { /* Provider errors can contain secrets. */ }
    return { ok: true, kind: 'workbench', data: await internal(workspace, workspaceId, { action: 'check', sourceId: r.id, ok }) as WikiData };
  }
  if (r.op === 'wb_wiki_sync') {
    if (running.has(workspaceId)) throw Error('当前工作区已有 Wiki 同步任务'); running.add(workspaceId); void sync(workspace, workspaceId, r.id, r.restart);
    return requestRetailWorker(workspace, workspaceId, { op: 'wb_wiki_sources' }, 'wb_wiki_sources');
  }
  throw Error('未知 Wiki 来源操作');
}
export async function tickRetailWiki(workspace: Workspace, workspaceId: string) {
  if (running.has(workspaceId)) return;
  const reply = await requestRetailWorker(workspace, workspaceId, { op: 'wb_wiki_sources' }, 'wb_wiki_sources');
  if (!reply.ok || reply.kind !== 'workbench' || reply.data.view !== 'wiki_sources') return;
  const source = reply.data.sources.find(s => s.enabled && s.intervalMinutes && (!s.nextSyncAt || Date.parse(s.nextSyncAt) <= Date.now()) && s.state !== 'error');
  if (source) { running.add(workspaceId); void sync(workspace, workspaceId, source.id, false); }
}
