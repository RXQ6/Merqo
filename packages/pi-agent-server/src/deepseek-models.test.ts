import { expect, test } from 'bun:test';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { registerDeepSeekModels } from './deepseek-models';

test('API-discovered IDs resolve under DeepSeek with current capabilities and original wire protocol', () => {
  const auth = AuthStorage.inMemory();
  auth.set('deepseek', { type: 'api_key', key: 'synthetic' });
  const registry = ModelRegistry.inMemory(auth);
  registerDeepSeekModels(registry, [{ id: 'pi/deepseek-flash', contextWindow: 1048576, maxOutputTokens: 393216, supportsImages: true, supportsThinking: true, supportedReasoningEfforts: ['low', 'high', 'max'] }]);
  const model = registry.find('deepseek', 'deepseek-flash');
  expect(model).toMatchObject({ provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'], compat: { thinkingFormat: 'deepseek' }, thinkingLevelMap: { low: 'low', medium: null, high: 'high', max: 'max' } });
  expect(registry.find('deepseek', 'deepseek-v4-flash')).toBeDefined();
  expect(registry.hasConfiguredAuth(model!)).toBe(true);
});
