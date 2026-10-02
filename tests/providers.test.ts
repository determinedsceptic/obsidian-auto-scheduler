import { describe, it, expect } from 'vitest';
import { Credentials } from '../src/credentials';
import { activeConfig, discoverModels, migrateByok, providerConfig, PROVIDER_TEMPLATES, validateByok, validateProvider } from '../src/providers';
import { DEFAULT_LLM } from '../src/types';
import type { ProviderConfig } from '../src/types';
import { chat } from '../src/llm';
import { config, now } from './helpers';
const provider = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'test-provider', name: '测试', protocol: 'chat-completions', baseUrl: 'https://example.test/v1', requiresKey: true, models: ['manual-model'], ...patch });
const messages = [{ role: 'user' as const, content: '复习两小时，很重要' }];
const tasks = [{ title: '复习', minutes: 120, priority: 4, split: true, minMinutes: 30, due: null, earliest: null }];
describe('BYOK providers and discovery', () => {
  it('migrates the existing endpoint/model and never embeds tokens', () => {
    const b = migrateByok(DEFAULT_LLM, 'vault-one'); validateByok(b); expect(activeConfig(b)).toEqual({ ...DEFAULT_LLM, requiresKey: true }); expect(JSON.stringify(b)).not.toContain('apiKey');
    expect(activeConfig(migrateByok({ ...DEFAULT_LLM, baseUrl: '', model: '' }, 'vault-one'))).toEqual({ ...DEFAULT_LLM, requiresKey: true });
  });
  it('validates each preset without requiring a live model catalog', () => {
    for (const [name, t] of Object.entries(PROVIDER_TEMPLATES)) {
      if (name === 'custom') continue;
      expect(() => validateProvider({ ...t, id: name, models: ['manually-entered'] })).not.toThrow();
    }
  });
  it('keeps same-named models separate across providers and rejects stale active IDs', () => {
    const b = { namespace: 'vault-one', providers: [provider(), provider({ id: 'other', baseUrl: 'https://other.test/v1' })], activeProviderId: 'other', activeModel: 'manual-model' };
    validateByok(b); expect(activeConfig(b).baseUrl).toBe('https://other.test/v1');
    expect(() => validateByok({ ...b, activeProviderId: 'missing' })).toThrow();
  });
  it('rejects malformed provider settings, duplicate models and plaintext key fields', () => {
    for (const patch of [{ models: [] }, { models: ['x', 'x'] }, { baseUrl: 'https://example.test/?key=abc' }, { id: '../vault' }]) expect(() => validateProvider(provider(patch))).toThrow();
    expect(() => validateProvider({ ...provider(), apiKey: 'test-only' } as ProviderConfig)).toThrow('unknown fields');
  });
  it('discovers compatible models without sending a chat request', async () => {
    const r = await discoverModels(provider(), 'test-only', async (url, headers) => {
      expect(url).toBe('https://example.test/v1/models'); expect(headers.Authorization).toBe('Bearer test-only');
      return { status: 200, json: { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] } };
    }); expect(r.models).toEqual(['a', 'b']); expect(r.note).toContain('Verify tool calling with an actual conversation');
  });
  it('discovers Gemini generation models using headers rather than URL keys', async () => {
    const r = await discoverModels(provider({ protocol: 'gemini' }), 'test-only', async (url, headers) => {
      expect(url).not.toContain('test-only'); expect(headers['x-goog-api-key']).toBe('test-only'); expect(headers.Authorization).toBeUndefined();
      return { status: 200, json: { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] } };
    }); expect(r.models).toEqual(['gemini-test']);
  });
  it('allows keyless local services and manual setup after discovery is unavailable', async () => {
    const p = provider({ ...PROVIDER_TEMPLATES.ollama, models: ['local-model'] });
    const r = await discoverModels(p, '', async (_, headers) => { expect(headers.Authorization).toBeUndefined(); return { status: 200, json: { data: [{ id: 'local-model' }] } }; }); expect(r.authenticated).toBe(false);
    await expect(discoverModels(p, '', async () => ({ status: 404, json: {} }))).rejects.toThrow('Enter model IDs manually'); expect(() => validateProvider(p)).not.toThrow();
  });
  it('distinguishes invalid authentication from timeouts and malformed discovery', async () => {
    await expect(discoverModels(provider(), 'test-only', async () => ({ status: 401, json: { error: 'secret' } }))).rejects.toThrow('Authentication rejected');
    await expect(discoverModels(provider(), 'test-only', () => new Promise(() => {}), 5)).rejects.toThrow('timed out');
    await expect(discoverModels(provider(), 'test-only', async () => ({ status: 200, json: { data: {} } }))).rejects.toThrow('Invalid model list format');
  });
});
describe('native provider tool protocols', () => {
  it('uses Anthropic messages, tool schema, version header and tool_use responses', async () => {
    const c = providerConfig(provider({ ...PROVIDER_TEMPLATES.anthropic, models: ['claude-test'] }), 'claude-test');
    const r = await chat(c, 'test-only', messages, config(), now, async (url, headers, body) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages'); expect(headers['x-api-key']).toBe('test-only'); expect(headers['anthropic-version']).toBe('2023-06-01'); expect(headers.Authorization).toBeUndefined();
      const d = JSON.parse(body); expect(d.system).toContain('Obsidian'); expect(d.tools[0].input_schema.required).toEqual(['tasks']);
      return { status: 200, json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'create_tasks', input: { tasks } }] } };
    }); expect(r.tasks).toEqual(tasks);
  });
  it('uses Gemini generateContent and JSON Schema function declarations', async () => {
    const c = providerConfig(provider({ ...PROVIDER_TEMPLATES.gemini, models: ['gemini-test'] }), 'gemini-test');
    const r = await chat(c, 'test-only', messages, config(), now, async (url, headers, body) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent'); expect(headers['x-goog-api-key']).toBe('test-only'); expect(url).not.toContain('test-only');
      const d = JSON.parse(body); expect(d.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties).toBe(false); expect(d.contents[0].role).toBe('user');
      return { status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'create_tasks', args: { tasks } } }] } }] } };
    }); expect(r.tasks).toEqual(tasks);
  });
  it('rejects truncated native responses and unknown native tools', async () => {
    for (const [protocol, json] of [ ['anthropic', { stop_reason: 'max_tokens', content: [] }], ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }], ['anthropic', { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'delete_file', input: {} }] }] ] as const) {
      await expect(chat({ ...DEFAULT_LLM, protocol }, 'test-only', messages, config(), now, async () => ({ status: 200, json }))).rejects.toThrow();
    }
  });
  it('uses compatible tools without Authorization for keyless localhost', async () => {
    await chat({ protocol: 'chat-completions', baseUrl: 'http://localhost:1234/v1', model: 'local', requiresKey: false }, '', messages, config(), now, async (_, headers) => {
      expect(headers.Authorization).toBeUndefined(); return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '预计需要多久？' } }] } };
    });
  });
});
describe('credential isolation and compatibility', () => {
  it('keeps independent session credentials and clears them on unload', async () => {
    const c = new Credentials('vault-one'); await c.set('a', 'test-a'); await c.set('b', 'test-b'); expect(await c.get('a')).toBe('test-a'); expect(await c.get('b')).toBe('test-b');
    c.clearSession(); expect(await c.get('a')).toBe(''); expect(JSON.stringify(c)).not.toContain('test-a');
  });
  it('survives restart through Keychain and never enumerates other secrets', async () => {
    const secrets = new Map<string, string>(); const storage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => { secrets.set(id, v); } };
    const c = new Credentials('vault-one', storage); await c.set('a', 'test-only');
    expect(await new Credentials('vault-one', storage).get('a')).toBe('test-only'); expect(await new Credentials('vault-two', storage).get('a')).toBe('');
    await c.set('a', ''); expect(await c.get('a')).toBe(''); expect(JSON.stringify(c)).not.toContain('test-only');
  });
  it('reports secure-storage failure without a plaintext fallback', async () => {
    const c = new Credentials('vault-one', { getSecret: () => { throw new Error('test-secret'); }, setSecret: () => { throw new Error('test-secret'); } });
    await expect(c.get('a')).rejects.toThrow('Could not read Obsidian Keychain'); await expect(c.set('a', 'test-only')).rejects.toThrow('not saved as plain text');
  });
});
