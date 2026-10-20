import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

export interface DiscoveredDeepSeekModel {
  id: string;
  contextWindow?: number;
  supportsImages?: boolean;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportedReasoningEfforts?: string[];
}

/** Preserve the SDK's DeepSeek wire protocol, but register API-discovered IDs. */
export function registerDeepSeekModels(registry: ModelRegistry, entries: Array<string | DiscoveredDeepSeekModel>, baseUrl?: string): void {
  const builtins = registry.getAll().filter(model => model.provider === 'deepseek');
  const template = builtins[0];
  if (!template || !entries.length) return;
  const models = new Map(builtins.map(model => [model.id, model]));
  for (const entry of entries) {
    const m = typeof entry === 'string' ? { id: entry } : entry;
    const id = m.id.replace(/^pi\//, '');
    const original = models.get(id) ?? template;
    const levels = m.supportedReasoningEfforts;
    models.set(id, {
      ...original, id, name: id,
      baseUrl: baseUrl || original.baseUrl,
      contextWindow: m.contextWindow || original.contextWindow,
      maxTokens: m.maxOutputTokens || original.maxTokens,
      reasoning: m.supportsThinking ?? original.reasoning,
      input: m.supportsImages === undefined ? original.input : m.supportsImages ? ['text', 'image'] : ['text'],
      ...(levels ? { thinkingLevelMap: {
        minimal: null, low: levels.includes('low') ? 'low' : null,
        medium: levels.includes('medium') ? 'medium' : null,
        high: levels.includes('high') ? 'high' : null,
        max: levels.includes('max') ? 'max' : null,
      } } : {}),
    });
  }
  // AuthStorage remains authoritative; this env reference satisfies the SDK's
  // provider registration contract without copying a secret into model metadata.
  registry.registerProvider('deepseek', { apiKey: '${DEEPSEEK_API_KEY}', baseUrl: baseUrl || template.baseUrl, api: template.api, models: [...models.values()] });
}
