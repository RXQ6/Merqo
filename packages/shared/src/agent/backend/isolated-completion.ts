import { getDefaultLlmConnection, getLlmConnection } from '../../config/index.ts';
import { getCredentialManager } from '../../credentials/index.ts';
import { loadWorkspaceConfig } from '../../workspaces/index.ts';
import { z } from 'zod';
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import { inferenceResponseInfo } from './isolated-telemetry.ts';
import type { InferenceConfig, InferenceTelemetry } from './isolated-telemetry.ts';
type ModelPort = (system: string, prompt: string) => Promise<string>;
export interface IsolatedCompletion { model: ModelPort; name: string; config: InferenceConfig }
const AnthropicResponse = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const ChatResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })) });

/** Direct inference requests expose no native SDK tools, filesystem, shell or MCP registry. */
export async function prepareIsolatedCompletion(workspacePath: string, deadline: string, onTelemetry?: (event: InferenceTelemetry) => void, signal?: AbortSignal, connectionSlug?: string): Promise<{ model: ModelPort; name: string; config: InferenceConfig }> {
  const slug = connectionSlug || loadWorkspaceConfig(workspacePath)?.defaults?.defaultLlmConnection || getDefaultLlmConnection();
  const connection = slug ? getLlmConnection(slug) : null;
  if (!connection) throw new Error('未配置模型连接。请在设置中添加 API 模型并设为默认，或明确选择离线演示。');
  if (!['api_key', 'api_key_with_endpoint', 'bearer_token', 'none'].includes(connection.authType)) throw new Error('本轮调查支持 API Key 或本地兼容模型；当前订阅/OAuth/云身份连接暂不支持，请另配 API 连接。');
  const provider = getProviders().find(p => p === connection.piAuthProvider);
  const providerModel = provider ? getModels(provider).find(m => m.id === connection.defaultModel?.replace(/^pi\//, '')) ?? getModels(provider)[0] : undefined;
  const protocol = connection.providerType === 'anthropic' ? 'anthropic-messages' : connection.customEndpoint?.api ?? providerModel?.api ?? null;
  if (protocol !== 'anthropic-messages' && protocol !== 'openai-completions') throw new Error('请配置 Anthropic Messages 或 OpenAI Chat Completions 兼容连接作为默认模型');
  if (!connection.defaultModel) throw new Error('模型连接尚未选择默认模型');
  const key = connection.authType === 'none' ? null : await getCredentialManager().getLlmApiKey(connection.slug);
  if (!key && connection.authType !== 'none') throw new Error('当前模型连接缺少凭据，请在设置中重新保存');
  const base = (connection.baseUrl || providerModel?.baseUrl || (protocol === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('模型地址必须为 HTTP 或 HTTPS');
  const modelId = connection.defaultModel.replace(/^pi\//, '');
  const disableThinking = !!(providerModel?.reasoning && provider === 'deepseek' && providerModel.thinkingLevelMap?.off !== null);
  const config: InferenceConfig = { connectionSlug: connection.slug, provider: provider ?? null, protocol, modelId,
    endpointOrigin: new URL(base).origin, authType: connection.authType, maxOutputTokens: 3500, thinking: disableThinking ? 'disabled' : 'provider_default' };
  return { config, name: `${connection.name} / ${modelId}`, model: async (system, prompt) => {
    const start = Date.now(); let info: InferenceTelemetry = { startedAt: new Date().toISOString(), durationMs: 0, status: 'failed', httpStatus: null, reportedModel: null, usage: null, nativeToolRequests: 0 };
    try {
    const remaining = Date.parse(deadline) - Date.now();
    if (remaining <= 0) throw new Error('调查超过 5 分钟预算');
    const anthropic = protocol === 'anthropic-messages';
    const url = anthropic ? `${base.replace(/\/v1$/, '')}/v1/messages` : `${base}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (anthropic) { headers['anthropic-version'] = '2023-06-01'; if (key) headers[connection.authType === 'bearer_token' ? 'Authorization' : 'x-api-key'] = connection.authType === 'bearer_token' ? `Bearer ${key}` : key; }
    else if (key) headers.Authorization = `Bearer ${key}`;
    const timeoutSignal = AbortSignal.timeout(Math.min(90000, remaining));
    const response = await fetch(url, { method: 'POST', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      body: JSON.stringify(anthropic ? { model: modelId, max_tokens: 3500, system, messages: [{ role: 'user', content: prompt }] } : { model: modelId, max_tokens: 3500, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false, ...(disableThinking ? { thinking: { type: 'disabled' } } : {}) }) });
    info.httpStatus = response.status;
    if (!response.ok) { info.status = 'http_error'; await response.body?.cancel(); throw new Error(`模型请求失败（HTTP ${response.status}），请检查连接、额度与模型权限`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('模型返回空响应');
    let raw = ''; const decoder = new TextDecoder(); let bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 500000) throw new Error('模型响应超过限制'); raw += decoder.decode(part.value, { stream: true }); } raw += decoder.decode(); }
    finally { await reader.cancel(); }
    const data: unknown = JSON.parse(raw);
    info = { ...info, ...inferenceResponseInfo(data) };
    const text = anthropic ? AnthropicResponse.parse(data).content.filter(b => b.type === 'text').map(b => b.text ?? '').join('') : ChatResponse.parse(data).choices[0]?.message.content;
    if (!text) throw new Error('模型未返回可用文本');
    info.status = 'succeeded';
    return text;
    } finally { info.durationMs = Date.now() - start; try { onTelemetry?.(info); } catch { /* Diagnostics cannot change inference behavior. */ } }
  } };
}

