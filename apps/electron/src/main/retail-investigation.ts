import { connectRetailMcp } from './retail-mcp';
import { getDefaultLlmConnection, getLlmConnection } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { createBackendFromConnection } from '../../../../packages/shared/src/agent/backend/factory';
import { z } from 'zod';
import { runSignalInvestigation } from '../../../../packages/retail-domain/src/signal-investigations';
import { runInvestigation, isSignalInvestigation } from '../../../../packages/retail-domain/src/investigations';
import type { AnyInvestigation, InvestigationReport, ModelPort, Trace } from '../../../../packages/retail-domain/src/investigations';
import type { InferenceConfig, InferenceTelemetry } from './retail-inference-telemetry';
type Save = (patch: { event?: Trace; report?: InvestigationReport; error?: string; model?: string }) => Promise<void>;
export async function createInvestigationModel(workspacePath: string, deadline: string, onTelemetry?: (event: InferenceTelemetry) => void, signal?: AbortSignal): Promise<{ model: ModelPort; name: string; config: InferenceConfig; close: () => void }> {
  const slug = loadWorkspaceConfig(workspacePath)?.defaults?.defaultLlmConnection || getDefaultLlmConnection();
  const connection = slug ? getLlmConnection(slug) : null;
  if (!connection || !slug) throw new Error('未配置模型连接');
  const backend = createBackendFromConnection(slug, { workspace: { id: 'retail-isolated', slug: 'retail-isolated', name: 'Retail isolated inference', rootPath: workspacePath, createdAt: 0 }, model: connection.defaultModel, isHeadless: true, skipConfigWatcher: true });
  try {
    if (!backend.createIsolatedCompletion) throw new Error('当前AgentBackend缺少隔离推理能力');
    const prepared = await backend.createIsolatedCompletion(deadline, onTelemetry, signal);
    return { ...prepared, close: () => backend.destroy() };
  } catch (error) { backend.destroy(); throw error; }
}
export async function executeRetailInvestigation(run: AnyInvestigation, workspacePath: string, save: Save, signal?: AbortSignal): Promise<void> {
  let closeModel: (() => void) | undefined;
  try {
    let model: ModelPort | null = null;
    if (run.mode === 'model') {
      const adapter = await createInvestigationModel(workspacePath, run.deadlineAt, undefined, signal);
      closeModel = adapter.close;
      let calls = run.trace.filter(t => t.stage === 'budget' && t.tool === 'model_request').length;
      model = async (system, prompt) => {
        signal?.throwIfAborted();
        if (calls >= 14) throw new Error('本调查模型调用预算已耗尽');
        await save({ event: { at: new Date().toISOString(), stage: 'budget', tool: 'model_request', evidenceId: `${run.id}:model:${++calls}`, data: { index: calls, epoch: run.epoch ?? 0 } } });
        const response = await adapter.model(system, prompt); signal?.throwIfAborted(); return response;
      };
      await save({ model: adapter.name });
    }
    const mcp = await connectRetailMcp(run, workspacePath);
    try {
      const report = isSignalInvestigation(run) ? await runSignalInvestigation(run, model, event => save({ event }), mcp.skill, mcp.tool) : await runInvestigation(run, model, event => save({ event }), mcp.skill, mcp.tool);
      await save({ report });
    } finally { await mcp.close(); }
  } catch (error) {
    // Never persist raw provider responses or credential-bearing URLs.
    const message = error instanceof z.ZodError ? '模型输出不符合调查契约，已拒绝报告，可重新调查' : error instanceof SyntaxError ? '模型未返回有效 JSON，已保留中间过程，可重新调查' : error instanceof Error ? error.message : '调查失败，可重新调查';
    await save({ error: message.slice(0, 1000) });
  } finally { closeModel?.(); }
}
