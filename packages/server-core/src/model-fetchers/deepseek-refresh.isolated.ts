import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('live refresh survives storage migration, preserves missing default, caches on failure and deduplicates', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'merqo-deepseek-refresh-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null, defaultLlmConnection: 'deepseek-test', llmConnections: [{ slug: 'deepseek-test', name: 'DeepSeek', providerType: 'pi', piAuthProvider: 'deepseek', authType: 'api_key', createdAt: 1, modelSelectionMode: 'userDefined3Tier', defaultModel: 'pi/deepseek-v4-flash', models: ['pi/deepseek-v4-flash'] }] }));
  const script = `
    import {ModelRefreshService} from './packages/server-core/src/model-fetchers/index.ts';
    import {getLlmConnection, updateLlmConnection, loadStoredConfig} from './packages/shared/src/config/index.ts';
    import assert from 'node:assert/strict';
    let calls=0, fail=false;
    const fetcher={refreshIntervalMs:0, async fetchModels(){ calls++; await new Promise(r=>setTimeout(r,20)); if(fail)throw new Error('HTTP 429'); return {models:[{id:'pi/deepseek-flash',name:'Flash current',shortName:'Flash',description:'API',provider:'pi',contextWindow:1048576,supportsImages:true,maxOutputTokens:393216,supportedReasoningEfforts:['low','high','max']}]}; }};
    const service=new ModelRefreshService({pi:fetcher,anthropic:fetcher},async()=>({apiKey:'synthetic'}));
    await Promise.all([service.refreshNow('deepseek-test'),service.refreshNow('deepseek-test')]);
    assert.equal(calls,1);
    let c=getLlmConnection('deepseek-test');
    assert.equal(c.defaultModel,'pi/deepseek-v4-flash');
    assert.equal(c.models[0].id,'pi/deepseek-flash');
    assert.equal(c.modelDiscovery.source,'live');
    const last=c.modelDiscovery.lastSuccessAt;
    loadStoredConfig();
    assert.equal(getLlmConnection('deepseek-test').models[0].id,'pi/deepseek-flash');
    updateLlmConnection('deepseek-test',{name:'renamed'});
    assert.equal(getLlmConnection('deepseek-test').modelDiscovery.lastSuccessAt,last);
    fail=true;await service.refreshNow('deepseek-test');c=getLlmConnection('deepseek-test');
    assert.equal(c.modelDiscovery.source,'cache');assert.equal(c.modelDiscovery.error,'HTTP 429');assert.equal(c.modelDiscovery.lastSuccessAt,last);
    assert.equal(c.models[0].maxOutputTokens,393216);assert.equal(c.defaultModel,'pi/deepseek-v4-flash');
    fail=false;await service.refreshNow('deepseek-test');assert.equal(getLlmConnection('deepseek-test').modelDiscovery.error,undefined);
    console.log('DEEPSEEK_REFRESH_PASS');
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], { cwd: join(import.meta.dir, '../../../..'), env: { ...process.env, CRAFT_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('DEEPSEEK_REFRESH_PASS');
}, 60_000);
