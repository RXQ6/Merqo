import { z } from 'zod';
import type { WikiSource, WikiDocumentPlan } from './wiki-contract';
export type WikiTransport = (url: string, options?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => Promise<string>;
export function publicWikiUrl(value: string): URL {
  const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw Error('文档源必须为不含凭据、查询参数或片段的 HTTPS 地址'); return url;
}
export class WikiClient {
  private token = '';
  constructor(private source: WikiSource, private secret: string | null, private transport: WikiTransport) {}
  private async api(route: string) {
    if (!this.token) {
      if (!this.source.appId || !this.secret) throw Error('请配置飞书应用 ID 和 App Secret');
      const response = z.object({ code: z.number(), tenant_access_token: z.string().optional() }).parse(JSON.parse(await this.transport('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: this.source.appId, app_secret: this.secret }) })));
      if (response.code !== 0 || !response.tenant_access_token) throw Error('飞书应用授权失败'); this.token = response.tenant_access_token;
    }
    const response = z.object({ code: z.number(), data: z.unknown().optional() }).parse(JSON.parse(await this.transport('https://open.feishu.cn/open-apis' + route, { headers: { Authorization: `Bearer ${this.token}` } })));
    if (response.code !== 0) throw Error('飞书读取失败，请核对权限'); return response.data;
  }
  private headers():Record<string,string> { return this.secret ? { Authorization: `Bearer ${this.secret}` } : {}; }
  async plan(): Promise<{ plan: WikiDocumentPlan[]; skipped: number }> {
    if (this.source.provider === 'markdown') {
      const manifestUrl = publicWikiUrl(this.source.endpoint), seen = new Set<string>(), plan: WikiDocumentPlan[] = []; let next: string | null = manifestUrl.href;
      while (next) {
        const url = publicWikiUrl(next); if (url.origin !== manifestUrl.origin || seen.has(url.href) || seen.size >= 20) throw Error('文档清单分页循环、跨域或超过20页'); seen.add(url.href);
        const manifest = z.strictObject({ version: z.literal(1), documents: z.array(z.strictObject({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(100), url: z.string().max(1000), directory: z.string().max(100).default('') })).max(500), next: z.string().max(1000).nullable().optional() }).parse(JSON.parse(await this.transport(url.href, { headers: this.headers() })));
        for (const doc of manifest.documents) { const link = publicWikiUrl(new URL(doc.url, url).href); if (link.origin !== manifestUrl.origin) throw Error('文档必须与清单同域'); plan.push({ key: doc.id, title: doc.title, url: link.href, directory: doc.directory }); }
        if (plan.length > 500) throw Error('单次来源最多500篇文档'); next = manifest.next ? new URL(manifest.next, url).href : null;
      }
      if (new Set(plan.map(p => p.key)).size !== plan.length) throw Error('文档清单标识重复'); return { plan, skipped: 0 };
    }
    const tenant=publicWikiUrl(this.source.endpoint);if(!tenant.hostname.endsWith('.feishu.cn'))throw Error('请提供企业飞书知识库 HTTPS 地址');
    if (!/^[0-9]{1,30}$/.test(this.source.spaceId) || this.source.rootNode && !/^[a-zA-Z0-9_-]{1,100}$/.test(this.source.rootNode)) throw Error('请填写正确的飞书知识空间 ID 和可选目录 token');
    const queue = [{ node: this.source.rootNode, directory: '' }], visited = new Set<string>(), plan: WikiDocumentPlan[] = []; let skipped = 0, requests = 0;
    while (queue.length) {
      const parent = queue.shift()!; let page = ''; const pageTokens = new Set<string>();
      do {
        if (++requests > 100) throw Error('知识目录超过本次100页读取上限');
        const query = new URLSearchParams({ page_size: '50', ...(parent.node ? { parent_node_token: parent.node } : {}), ...(page ? { page_token: page } : {}) });
        const data = z.object({ items: z.array(z.object({ node_token: z.string().min(1).max(200), obj_token: z.string().min(1).max(200), obj_type: z.string(), title: z.string().max(100), has_child: z.boolean() })).default([]), has_more: z.boolean().default(false), page_token: z.string().optional() }).parse(await this.api(`/wiki/v2/spaces/${this.source.spaceId}/nodes?${query}`));
        for (const n of data.items) {
          if (visited.has(n.node_token)) throw Error('飞书目录存在重复节点'); visited.add(n.node_token);
          if (n.obj_type === 'docx') plan.push({ key: n.node_token, token: n.obj_token, title: n.title || '未命名文档', url: `${tenant.origin}/wiki/${encodeURIComponent(n.node_token)}`, directory: parent.directory.slice(0, 100) }); else skipped++;
          if (n.has_child) queue.push({ node: n.node_token, directory: [parent.directory, n.title].filter(Boolean).join('/') });
          if (visited.size > 1000 || plan.length > 500) throw Error('知识空间超过500篇文档或1000个节点，请缩小同步目录');
        }
        page = data.has_more ? data.page_token ?? '' : ''; if (data.has_more && (!page || pageTokens.has(page))) throw Error('飞书分页标识缺失或循环'); pageTokens.add(page);
      } while (page);
    }
    return { plan, skipped };
  }
  async document(doc: WikiDocumentPlan): Promise<string> {
    if (this.source.provider === 'markdown') { const url = publicWikiUrl(doc.url); if (url.origin !== publicWikiUrl(this.source.endpoint).origin) throw Error('文档域名与来源不一致'); return z.string().trim().min(1).max(60000).parse(await this.transport(url.href, { headers: this.headers() })); }
    if (!doc.token || !/^[a-zA-Z0-9_-]+$/.test(doc.token)) throw Error('文档 token 无效');
    const data = z.object({ content: z.string().max(60000) }).parse(await this.api(`/docx/v1/documents/${doc.token}/raw_content`));
    return data.content.trim() || '（此文档没有可同步的文本内容）';
  }
}
