import type { DecisionDraft } from './decisions';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded' | 'invalidated';
export interface SimulationApprover { id: 'local-simulation-approver'; role: 'approver'; environment: 'simulation' }
export interface ApprovalResolution {
  id: string; requestId: string; decisionId: string; decisionVersion: number; actionHash: string; policyVersion: string;
  evidenceHash: string; reportHash: string; expiresAt: string; decision: 'approved' | 'rejected'; reason: string; resolvedAt: string; actor: SimulationApprover;
}
export interface ApprovalInvalidation { requestId: string; status: 'expired' | 'superseded' | 'invalidated'; reasons: string[]; at: string }
export interface ApprovalAudit { id: number; event: string; at: string; actor: string; reason?: string }
export interface ApprovalEvidence { observedAt: string; importedAt: string; source: 'demo' | 'csv'; reviewer: string; mode: string }
export interface ApprovalView { evidence: ApprovalEvidence | null; id: string; status: ApprovalStatus; decision: DecisionDraft; resolution: ApprovalResolution | null; invalidation: ApprovalInvalidation | null; blockers: string[]; audit: ApprovalAudit[] }
