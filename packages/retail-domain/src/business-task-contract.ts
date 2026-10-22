import { z } from 'zod';

export const TaskStatus = z.enum(['open', 'doing', 'blocked', 'done', 'cancelled']);
export const TaskPurpose = z.enum(['analysis_followup', 'simulation_action']);
export const TaskOriginInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('investigation'), id: z.string().uuid() }),
  z.strictObject({ kind: z.literal('decision'), id: z.string().uuid(), version: z.number().int().positive() }),
]);
const fields = {
  title: z.string().trim().min(1).max(120), owner: z.string().trim().min(1).max(80),
  dueAt: z.string().datetime({ offset: true }), priority: z.enum(['normal', 'high']),
};
const identity = { id: z.string().uuid(), expectedVersion: z.number().int().positive() };
const note = z.string().trim().min(1).max(2000);
export const TaskCreateSchema = z.strictObject({ op: z.literal('task_create'), origin: TaskOriginInput, purpose: TaskPurpose, ...fields, description: z.string().trim().max(2000) });
export const TaskQuerySchema = z.strictObject({ op: z.literal('tasks'), status: z.enum(['all', ...TaskStatus.options]).default('all'), overdueOnly: z.boolean().default(false), search: z.string().trim().max(120).default(''), offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(50).default(30) });
export const TaskPublicSchemas = [TaskCreateSchema, TaskQuerySchema,
  z.strictObject({ op: z.literal('task_get'), id: z.string().uuid() }),
  z.strictObject({ op: z.literal('task_edit'), ...identity, ...fields, note }),
  z.strictObject({ op: z.literal('task_transition'), ...identity, status: TaskStatus, note }),
  z.strictObject({ op: z.literal('task_note'), ...identity, note }),
] as const;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskQuery = z.infer<typeof TaskQuerySchema>;
export type TaskMutation = z.infer<typeof TaskPublicSchemas[3]> | z.infer<typeof TaskPublicSchemas[4]> | z.infer<typeof TaskPublicSchemas[5]>;
export interface BusinessTask {
  id: string; workspaceId: string; version: number; title: string; description: string; owner: string;
  purpose: z.infer<typeof TaskPurpose>; priority: 'normal' | 'high'; dueAt: string; status: z.infer<typeof TaskStatus>;
  createdAt: string; updatedAt: string;
  origin: { investigationId: string; decisionId: string | null; decisionVersion: number | null; actionHash: string | null };
  scope: { source: 'demo' | 'csv'; sourceId: string | null; shop: string; channel: string; sku: string; spec: string | null; date: string; scenario: 'margin' | 'inventory' | 'ads'; warehouse: string | null; campaign: string | null };
  entityKey: string;
  evidence: { recordId: string; evidenceHash: string; reportHash: string; summary: string; mode: 'model' | 'replay'; reviewer: string; ruleVersion: string };
}
export interface TaskLinkState {
  decisionState: string | null; approvalId: string | null; executionId: string | null; receiptId: string | null;
  stale: boolean; warning: string | null;
}
export interface TaskView { task: BusinessTask; overdue: boolean; link: TaskLinkState }
export interface TaskEvent { version: number; at: string; action: 'created' | 'edited' | 'transitioned' | 'noted'; from: BusinessTask['status'] | null; to: BusinessTask['status']; note: string; actor: 'local-operator'; snapshot: BusinessTask }
export interface TaskDetail extends TaskView { events: TaskEvent[]; eventCount: number }
export interface TaskPage { items: TaskView[]; total: number; offset: number; limit: number; counts: Record<BusinessTask['status'], number> & { overdue: number }; checkedAt: string }
