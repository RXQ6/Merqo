import { z } from 'zod';
import type { LibraryItem } from './workbench-contract';
import type { BusinessTask } from './business-task-contract';
const id = z.string().uuid();
export const WikiMetaSchema = z.strictObject({
  category: z.enum(['rule', 'method', 'material']), status: z.enum(['draft', 'published', 'retired', 'deleted']),
  directory: z.string().trim().max(100).default(''), shop: z.string().trim().max(100).default(''), sku: z.string().trim().max(100).default(''),
  validFrom: z.union([z.literal(''), z.string().date()]).default(''), validTo: z.union([z.literal(''), z.string().date()]).default(''),
}).refine(v => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, '有效期起止顺序错误');
export type WikiMeta = z.infer<typeof WikiMetaSchema> & { external?: { sourceId: string; key: string; url: string; hash: string; syncedAt: string; available: boolean }; caseId?: string; taskId?: string };
export const WikiSourceFields = z.strictObject({
  name: z.string().trim().min(1).max(100), provider: z.enum(['markdown', 'feishu']),
  endpoint: z.string().trim().max(1000).default(''), appId: z.string().trim().max(100).default(''), spaceId: z.string().trim().max(100).default(''), rootNode: z.string().trim().max(100).default(''),
  scenario: z.enum(['all', 'margin', 'inventory', 'ads']), intervalMinutes: z.number().int().min(0).max(10080), enabled: z.boolean(),
});
export type WikiSource = z.infer<typeof WikiSourceFields> & { id: string; version: number; credentialRef: string | null; state: 'unchecked' | 'ready' | 'error' | 'disabled'; lastError: string | null; lastSyncAt: string | null; nextSyncAt: string | null };
export type PublicWikiSource = Omit<WikiSource, 'credentialRef'> & { hasCredential: boolean };
export interface WikiDocumentPlan { key: string; title: string; url: string; token?: string | undefined; directory: string }
export interface WikiJob { id: string; sourceId: string; sourceVersion: number; status: 'running' | 'failed' | 'completed'; index: number; plan: WikiDocumentPlan[]; changed: number; unchanged: number; skipped: number; error: string | null; startedAt: string; updatedAt: string }
export interface WikiReference { investigationId: string; item: LibraryItem; at: string }
export const WikiSchemas = [
  z.strictObject({ op: z.literal('wb_wiki_list'), search: z.string().trim().max(120).default(''), category: z.enum(['all', 'rule', 'method', 'material']).default('all'), status: z.enum(['all', 'draft', 'published', 'retired', 'deleted']).default('all'), directory: z.string().max(100).default(''), offset: z.number().int().min(0).max(100000).default(0) }),
  z.strictObject({ op: z.literal('wb_wiki_get'), id, version: z.number().int().positive().optional() }),
  z.strictObject({ op: z.literal('wb_wiki_save'), id: id.optional(), expectedVersion: z.number().int().min(0), title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(60000), scenario: z.enum(['all', 'margin', 'inventory', 'ads']), meta: WikiMetaSchema }),
  z.strictObject({ op: z.literal('wb_wiki_revert'), id, expectedVersion: z.number().int().positive(), version: z.number().int().positive() }),
  z.strictObject({ op: z.literal('wb_wiki_references'), investigationId: id }),
  z.strictObject({ op: z.literal('wb_wiki_reference'), investigationId: id, itemId: id, expectedVersion: z.number().int().positive() }),
  z.strictObject({ op: z.literal('wb_wiki_from_case'), id }),
  z.strictObject({ op: z.literal('wb_wiki_from_task'), taskId: id, expectedVersion: z.number().int().positive() }),
  z.strictObject({ op: z.literal('wb_wiki_task_create'), itemId: id, expectedVersion: z.number().int().positive(), investigationId: id, title: z.string().trim().min(1).max(120), owner: z.string().trim().min(1).max(80), dueAt: z.string().datetime({offset:true}) }),
  z.strictObject({ op: z.literal('wb_wiki_sources') }),
  z.strictObject({ op: z.literal('wb_wiki_source_save'), id: id.optional(), expectedVersion: z.number().int().min(0), config: WikiSourceFields, secret: z.string().min(1).max(4000).optional() }),
  z.strictObject({ op: z.literal('wb_wiki_sync'), id, restart: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('wb_wiki_check'), id }),
] as const;
export const WikiRequestSchema = z.union(WikiSchemas);
export type WikiRequest = z.infer<typeof WikiRequestSchema>;
export type WikiData =
  { view: 'wiki_list'; items: LibraryItem[]; total: number; offset: number; directories: string[]; recent: LibraryItem[]; maintenance: LibraryItem[] } |
  { view: 'wiki_detail'; item: LibraryItem; latestVersion: number; versions: Array<{ version: number; updatedAt: string; title: string }>; references: WikiReference[]; taskIds: string[]; investigations: Array<{id:string;label:string}> } |
  { view: 'wiki_references'; references: WikiReference[]; candidates: Array<{ item: LibraryItem; reason: string }>; warnings: string[] } |
  { view: 'wiki_sources'; sources: PublicWikiSource[]; jobs: Array<Omit<WikiJob, 'plan'> & { total: number }> } |
  { view: 'wiki_task'; task: BusinessTask };
export function wikiMeta(item: LibraryItem): WikiMeta { return item.wiki ?? { category: 'method', status: item.archived ? 'retired' : 'published', directory: item.kind === 'topic' ? '经营专题' : item.kind === 'tag' ? '场景标签' : '', shop: '', sku: '', validFrom: '', validTo: '' }; }
