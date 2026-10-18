export interface InferenceUsage {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
}
export interface InferenceTelemetry {
  startedAt: string; durationMs: number; status: 'succeeded' | 'http_error' | 'failed'; httpStatus: number | null;
  reportedModel: string | null; usage: InferenceUsage | null; nativeToolRequests: number;
}
export interface InferenceConfig {
  connectionSlug: string; provider: string | null; protocol: string; modelId: string;
  endpointOrigin: string; authType: string; maxOutputTokens: number; thinking: 'disabled' | 'provider_default';
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
/** Provider counters retain their declared meaning. Missing counters are unknown, never zero. */
export function inferenceResponseInfo(data: unknown): Pick<InferenceTelemetry, 'reportedModel' | 'usage' | 'nativeToolRequests'> {
  const root = object(data), raw = object(root.usage);
  const details = object(raw.completion_tokens_details);
  const usage = root.usage && typeof root.usage === 'object' ? {
    inputTokens: count(raw.input_tokens ?? raw.prompt_tokens), outputTokens: count(raw.output_tokens ?? raw.completion_tokens),
    totalTokens: count(raw.total_tokens), cacheReadTokens: count(raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens),
    cacheWriteTokens: count(raw.cache_creation_input_tokens), reasoningTokens: count(details.reasoning_tokens),
  } : null;
  let nativeToolRequests = Array.isArray(root.content) ? root.content.filter(c => object(c).type === 'tool_use').length : 0;
  if (Array.isArray(root.choices)) for (const choice of root.choices) {
    const message = object(object(choice).message);
    nativeToolRequests += Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
    if (message.function_call) nativeToolRequests++;
  }
  return { reportedModel: typeof root.model === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(root.model) ? root.model : null, usage, nativeToolRequests };
}
