import { z } from 'zod';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
export const CheckConfigSchema = z.strictObject({ enabled: z.boolean(), intervalMinutes: z.union([z.literal(15), z.literal(60), z.literal(1440)]), source: z.enum(['demo', 'csv']) });
export type CheckConfigInput = z.infer<typeof CheckConfigSchema>;
export interface CheckConfig extends CheckConfigInput { revision: number; configuredAt: string; startsAt: string }
export interface CheckFinding { key: string; scenario: 'margin' | 'inventory' | 'ads'; record: EvidenceRecord | SignalRecord }
export interface CheckResult { checked: number; byScenario: Record<'margin' | 'inventory' | 'ads', number>; anomalies: number; newFindings: number; repeatedFindings: number; findings: CheckFinding[]; truncated: boolean; warnings: string[]; observedAt: string }
export interface CheckRun { id: string; config: CheckConfig; slot: string; trigger: 'scheduled' | 'manual' | 'catchup'; status: 'running' | 'succeeded' | 'failed' | 'interrupted'; attempt: number; startedAt: string; finishedAt: string | null; error: string | null; result: CheckResult | null; history: Array<{ attempt: number; startedAt: string; finishedAt: string | null; status: string; error: string | null }> }
export interface ChecksView { config: CheckConfig; runs: CheckRun[]; pendingSlots: string[]; olderSlotsExcluded: number; now: string; lastAction?: { created: number; reused: number } }
