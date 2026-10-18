import { expect, test } from 'bun:test';
import { inferenceResponseInfo } from '../retail-inference-telemetry';

test('provider counters preserve unknown values and reject invalid counters', () => {
  expect(inferenceResponseInfo({}).usage).toBeNull();
  const info = inferenceResponseInfo({ model: 'deepseek-v4-flash', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_cache_hit_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } });
  expect(info.reportedModel).toBe('deepseek-v4-flash');
  expect(info.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20, cacheReadTokens: 3, cacheWriteTokens: null, reasoningTokens: 0 });
  expect(inferenceResponseInfo({ model: 'unsafe?key=secret', usage: { input_tokens: -1, output_tokens: 1.5, total_tokens: '2' } })).toMatchObject({ reportedModel: null, usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
});

test('Anthropic counters are not relabeled as full totals and native tool calls are counted', () => {
  const info = inferenceResponseInfo({ usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9, cache_creation_input_tokens: 2 }, content: [{ type: 'tool_use' }, { type: 'text' }] });
  expect(info.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: null, cacheReadTokens: 9, cacheWriteTokens: 2, reasoningTokens: null });
  expect(info.nativeToolRequests).toBe(1);
  expect(inferenceResponseInfo({ choices: [{ message: { tool_calls: [{}, {}], function_call: {} } }] }).nativeToolRequests).toBe(3);
});
