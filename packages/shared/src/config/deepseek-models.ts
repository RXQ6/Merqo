import type { ModelDefinition } from './models';

/** Server only: never send credentials or provider response bodies to the renderer. */
export async function fetchDeepSeekModels(apiKey: string | undefined, baseUrl = 'https://api.deepseek.com', timeoutMs = 15_000): Promise<ModelDefinition[]> {
  if (!apiKey) throw new Error('DeepSeek：请先保存 API Key');
  const endpoint = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new Error('DeepSeek 模型列表请求失败或超时，请检查网络与接口地址');
  }
  if (!response.ok) throw new Error(`DeepSeek 模型列表请求失败（HTTP ${response.status}）`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
    throw new Error('DeepSeek 返回了无效的模型列表');
  }
  const models: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const row of body.data) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id)) continue;
    seen.add(row.id);
    const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    const levels = Array.isArray(row.effort?.supported_levels)
      ? row.effort.supported_levels.filter((level: unknown): level is string => typeof level === 'string' && level !== 'none') : undefined;
    models.push({
      id: `pi/${row.id}`, name: typeof row.name === 'string' && row.name ? row.name : row.id,
      shortName: typeof row.name === 'string' && row.name ? row.name : row.id,
      description: 'DeepSeek API', provider: 'pi',
      contextWindow: positive(row.context_window) ?? 0,
      maxOutputTokens: positive(row.max_output_tokens),
      ...(Array.isArray(row.input_modalities) ? { supportsImages: row.input_modalities.includes('image') } : {}),
      ...(levels ? { supportedReasoningEfforts: levels, supportsThinking: levels.length > 0 } : {}),
    });
  }
  if (!models.length) throw new Error('DeepSeek 未返回可用模型，已保留原有列表');
  return models;
}
