import { describe, expect, it } from 'bun:test';
import { fetchDeepSeekModels } from '../deepseek-models';

describe('DeepSeek live model discovery', () => {
  it('uses authenticated GET /models and maps all returned IDs and explicit capabilities', async () => {
    let requestPath = '';
    let authorization = '';
    const server = Bun.serve({ port: 0, fetch(request) {
      requestPath = new URL(request.url).pathname;
      authorization = request.headers.get('authorization') ?? '';
      return Response.json({ data: [
        { id: 'deepseek-flash', name: 'Flash current', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max'] } },
        { id: 'future-model', input_modalities: ['text'], effort: { supported_levels: [] } },
        { id: 'unknown-capabilities' }, { id: 'future-model' }, { id: '' },
      ] });
    } });
    try {
      const models = await fetchDeepSeekModels('synthetic-key', `http://127.0.0.1:${server.port}/v1/`);
      expect(requestPath).toBe('/v1/models');
      expect(authorization).toBe('Bearer synthetic-key');
      expect(models.map(m => m.id)).toEqual(['pi/deepseek-flash', 'pi/future-model', 'pi/unknown-capabilities']);
      expect(models[0]).toMatchObject({ name: 'Flash current', contextWindow: 1048576, maxOutputTokens: 393216, supportsImages: true, supportedReasoningEfforts: ['low', 'high', 'max'] });
      expect(models[1]).toMatchObject({ supportsImages: false, supportsThinking: false, contextWindow: 0 });
      expect(models[2]?.supportsImages).toBeUndefined();
      expect(models[2]?.supportedReasoningEfforts).toBeUndefined();
    } finally { server.stop(true); }
  });
  it('rejects failures and empty lists without exposing provider bodies or following redirects', async () => {
    for (const status of [401, 429, 500, 302]) {
      const server = Bun.serve({ port: 0, fetch: () => new Response('synthetic-secret', { status, headers: { Location: 'http://127.0.0.1:1' } }) });
      try {
        await expect(fetchDeepSeekModels('synthetic-key', `http://127.0.0.1:${server.port}`)).rejects.not.toThrow('synthetic-secret');
      } finally { server.stop(true); }
    }
    for (const body of [{ data: [] }, {}, { data: [{ id: null }] }]) {
      const server = Bun.serve({ port: 0, fetch: () => Response.json(body) });
      try { await expect(fetchDeepSeekModels('key', `http://127.0.0.1:${server.port}`)).rejects.toThrow(); }
      finally { server.stop(true); }
    }
    await expect(fetchDeepSeekModels(undefined)).rejects.toThrow('API Key');
  });
});
