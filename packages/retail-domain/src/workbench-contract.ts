import { z } from 'zod';
import {ExperienceSchemas,type ExperienceData,type CaseReference} from './experience-contract';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
import type { AnyInvestigation } from './investigations';
import type { DecisionDraft } from './decisions';
import type { BusinessTask, TaskDetail } from './business-task-contract';
import { WikiSchemas } from './wiki-contract';
import type { WikiData, WikiMeta, WikiReference } from './wiki-contract';
export type BusinessEvidence = EvidenceRecord | SignalRecord;
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(2000);
const day = z.string().date();
export const PeriodSchema = z.strictObject({ startDate: day, endDate: day }).refine(v => v.startDate <= v.endDate && Date.parse(v.endDate) - Date.parse(v.startDate) <= 366 * 86400000, '请选择顺序正确且不超过367天的业务窗口');
export const EntityQuery = z.strictObject({ op: z.literal('wb_entities'), search: z.string().trim().max(120).default(''), source: z.enum(['all', 'demo', 'csv']).default('all'), offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(50).default(30) });
export const LibraryInput = z.strictObject({ id: id.optional(), expectedVersion: z.number().int().min(0), kind: z.enum(['tag', 'method', 'topic']), title: z.string().trim().min(1).max(100), scenario: z.enum(['all', 'margin', 'inventory', 'ads']), body: text, archived: z.boolean() });
export const ConfigInput = z.strictObject({ expectedVersion: z.number().int().positive(), remindersEnabled: z.boolean(), autoFindingTasks: z.boolean(), owner: z.string().trim().min(1).max(80), dueHours: z.number().int().min(1).max(720) });
export const WorkbenchSchemas = [...ExperienceSchemas,...WikiSchemas, EntityQuery,
  z.strictObject({ op: z.literal('wb_entity'), entityId: hash, period: PeriodSchema }),
  z.strictObject({ op: z.literal('wb_conversations'), entityId: hash }),
  z.strictObject({ op: z.literal('wb_ask'), entityId: hash, period: PeriodSchema, questionId: id, question: text, mode: z.enum(['model', 'replay']) }),
  z.strictObject({ op: z.literal('wb_library') }),
  z.strictObject({ op: z.literal('wb_library_links'), itemId: id }),
  z.strictObject({ op: z.literal('wb_task_tools'), taskId: id }),
  LibraryInput.extend({ op: z.literal('wb_library_save') }),
  z.strictObject({ op: z.literal('wb_bind'), taskId: id, expectedTaskVersion: z.number().int().positive(), itemId: id }),
  z.strictObject({ op: z.literal('wb_bindings'), taskId: id }),
  z.strictObject({ op: z.literal('wb_followups') }),
  ConfigInput.extend({ op: z.literal('wb_configure') }),
  z.strictObject({ op: z.literal('wb_plan'), taskId: id, expectedTaskVersion: z.number().int().positive(), expectedVersion: z.number().int().min(0), dueAt: z.string().datetime({ offset: true }), repeatDays: z.number().int().min(0).max(365), enabled: z.boolean() }),
  z.strictObject({ op: z.literal('wb_ack'), id, note: text }),
  z.strictObject({ op: z.literal('wb_tick') }),
  z.strictObject({ op: z.literal('wb_cases'), search: z.string().trim().max(120).default(''), offset: z.number().int().min(0).max(1000000).default(0) }),
  z.strictObject({ op: z.literal('wb_case'), id }),
  z.strictObject({ op: z.literal('wb_archive'), taskId: id, expectedTaskVersion: z.number().int().positive(), title: z.string().trim().min(1).max(120), lesson: text, outcome: text }),
] as const;
export const WorkbenchRequestSchema = z.union(WorkbenchSchemas);
export type WorkbenchRequest = z.infer<typeof WorkbenchSchemas[number]>;
export interface EntitySummary { id: string; scope: BusinessTask['scope']; name: string; dates: { first: string; last: string }; records: number; investigations: number; decisions: number; tasks: number; unknownSource: boolean }
export interface EntityDetail { entity: EntitySummary; period: z.infer<typeof PeriodSchema>; evidence: BusinessEvidence[]; evidenceTotal: number; investigations: Array<Pick<AnyInvestigation, 'id' | 'state' | 'mode' | 'createdAt'> & { summary: string }>; investigationTotal: number; decisions: Array<Pick<DecisionDraft, 'id' | 'version' | 'state' | 'selectedKind'>>; decisionTotal: number; tasks: BusinessTask[]; taskTotal: number; knowledge:TaskBinding[]; wiki?:LibraryItem[]; cases:Array<Pick<BusinessCase,'id'|'title'|'lesson'|'declaredOutcome'|'category'|'limitation'>>; warnings: string[]; hash: string }
export interface ContextQuestion { id: string; entityId: string; question: string; mode: 'model' | 'replay'; status: 'pending' | 'answered' | 'failed'; createdAt: string; deadlineAt: string; context: EntityDetail; history: Array<{ question: string; answer: string }>; answer: string | null; citations: string[]; error: string | null }
export interface LibraryItem { id: string; version: number; kind: 'tag' | 'method' | 'topic'; title: string; scenario: 'all' | 'margin' | 'inventory' | 'ads'; body: string; archived: boolean; updatedAt: string; wiki?: WikiMeta }
export interface TaskBinding { taskId: string; taskVersion: number; item: LibraryItem; at: string }
export interface FollowupConfig { version: number; remindersEnabled: boolean; autoFindingTasks: boolean; owner: string; dueHours: number; configuredAt: string }
export interface FollowupPlan { id: string; taskId: string; version: number; dueAt: string; repeatDays: number; enabled: boolean; updatedAt: string }
export interface Reminder { id: string; taskId: string; title: string; dueAt: string; createdAt: string; acknowledgedAt: string | null; note: string | null }
export interface FollowupObservation { id: string; planId: string; taskId: string; dueAt: string; observedAt: string; status: 'observed' | 'needs_evidence'; baseline: BusinessEvidence; evidence: BusinessEvidence[]; warnings: string[]; skippedSlots: number }
export interface BusinessCase { id: string; taskId: string; taskVersion: number; title: string; lesson: string; declaredOutcome: string; createdAt: string; category: 'simulation' | 'analysis'; task: TaskDetail; bindings: TaskBinding[]; observations: FollowupObservation[]; wikiReferences?: WikiReference[]; caseReferences?:CaseReference[]; limitation: string }
export type WorkbenchData = ExperienceData | WikiData |
  { view: 'entities'; items: EntitySummary[]; total: number; offset: number } |
  { view: 'entity'; detail: EntityDetail } |
  { view: 'conversations'; items: ContextQuestion[]; selected?: ContextQuestion; created?: boolean } |
  { view: 'library'; items: LibraryItem[]; total: number } |
  { view: 'bindings'; items: TaskBinding[] } |
  { view: 'library_links'; items: BusinessTask[]; total: number } |
  { view: 'task_tools'; bindings: TaskBinding[]; plan: FollowupPlan | null; observations: FollowupObservation[] } |
  { view: 'followups'; config: FollowupConfig; plans: FollowupPlan[]; reminders: Reminder[]; unread: number; observations: FollowupObservation[]; pendingFindings: number } |
  { view: 'cases'; items: Array<Pick<BusinessCase, 'id' | 'title' | 'category' | 'createdAt' | 'taskId'>>; total: number; offset: number } |
  { view: 'case'; item: BusinessCase };
