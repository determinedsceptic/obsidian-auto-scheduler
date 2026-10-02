import type { ByokSettings, LlmSettings, ProviderConfig } from './types';
import { DEFAULT_LLM } from './types';
import { endpoint, authHeaders } from './llm';
export interface ProviderTemplate { name: string; protocol: LlmSettings['protocol']; baseUrl: string; requiresKey: boolean; models: string[] }
export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
  openai: { name: 'OpenAI', protocol: DEFAULT_LLM.protocol, baseUrl: DEFAULT_LLM.baseUrl, requiresKey: true, models: ['gpt-6-luna'] },
  anthropic: { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', requiresKey: true, models: [] },
  gemini: { name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', requiresKey: true, models: [] },
  openrouter: { name: 'OpenRouter', protocol: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, models: [] },
  deepseek: { name: 'DeepSeek', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, models: [] },
  ollama: { name: 'Ollama', protocol: 'chat-completions', baseUrl: 'http://localhost:11434/v1', requiresKey: false, models: [] },
  lmstudio: { name: 'LM Studio', protocol: 'chat-completions', baseUrl: 'http://localhost:1234/v1', requiresKey: false, models: [] },
  custom: { name: '自定义服务商', protocol: 'chat-completions', baseUrl: '', requiresKey: true, models: [] },
};
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);
export function providerConfig(provider: ProviderConfig, model: string): LlmSettings {
  return { protocol: provider.protocol, baseUrl: provider.baseUrl, model, requiresKey: provider.requiresKey };
}
export function validateProvider(p: ProviderConfig): void {
  if (!p || Object.keys(p).some(k => !['id', 'name', 'protocol', 'baseUrl', 'requiresKey', 'models'].includes(k))) throw new Error('服务商配置包含未知字段');
  if (!safeId(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || /[\r\n\x00-\x1f]/.test(p.name) || typeof p.requiresKey !== 'boolean') throw new Error('服务商配置无效');
  if (!Array.isArray(p.models) || !p.models.length || p.models.length > 100 || new Set(p.models).size !== p.models.length) throw new Error('请选择或手动添加 1–100 个不同的模型');
  for (const model of p.models) endpoint(providerConfig(p, model));
}
export function migrateByok(legacy: LlmSettings, namespace: string): ByokSettings {
  const p: ProviderConfig = { id: 'legacy', name: '已有 LLM 配置', protocol: legacy.protocol, baseUrl: legacy.baseUrl, requiresKey: true, models: [legacy.model] };
  try { validateProvider(p); } catch { p.protocol = DEFAULT_LLM.protocol; p.baseUrl = DEFAULT_LLM.baseUrl; p.models = [DEFAULT_LLM.model]; }
  return { namespace, providers: [p], activeProviderId: p.id, activeModel: p.models[0] };
}
export function validateByok(value: unknown): asserts value is ByokSettings {
  const b = value as ByokSettings;
  if (!b || Object.keys(b).some(k => !['namespace', 'providers', 'activeProviderId', 'activeModel'].includes(k)) || !safeId(b.namespace) || !Array.isArray(b.providers) || b.providers.length > 30 || new Set(b.providers.map(p => p.id)).size !== b.providers.length) throw new Error('BYOK 配置格式无效');
  for (const p of b.providers) validateProvider(p);
  if (b.providers.length && !b.providers.some(p => p.id === b.activeProviderId && p.models.includes(b.activeModel))) throw new Error('当前服务商或模型不存在');
}
export function activeConfig(b: ByokSettings): LlmSettings {
  const p = b.providers.find(p => p.id === b.activeProviderId);
  if (!p || !p.models.includes(b.activeModel)) throw new Error('请先添加服务商并选择模型');
  return providerConfig(p, b.activeModel);
}
export type DiscoveryTransport = (url: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown }>;
export interface Discovery { models: string[]; authenticated: boolean; note: string }
export async function discoverModels(p: ProviderConfig, token: string, transport: DiscoveryTransport, timeoutMs = 15000): Promise<Discovery> {
  const config = providerConfig(p, p.models[0] || 'discovery'); endpoint(config);
  if (p.requiresKey && !token.trim()) throw new Error('请填写 API 令牌后测试');
  const base = new URL(p.baseUrl); const url = base.toString().replace(/\/$/, '') + '/models';
  let timer: ReturnType<typeof setTimeout> | undefined; let response: Awaited<ReturnType<DiscoveryTransport>>;
  try { response = await Promise.race([transport(url, authHeaders(config, token)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]); }
  catch { throw new Error('连接失败或超时；可手动填写模型 ID 后保存离线配置'); }
  finally { if (timer) clearTimeout(timer); }
  if (response.status === 401 || response.status === 403) throw new Error('服务商拒绝鉴权，请检查令牌和权限');
  if (response.status < 200 || response.status >= 300) throw new Error(`模型发现返回 HTTP ${response.status}；可手动填写模型 ID（不代表鉴权已通过）`);
  const data = response.json as { data?: { id?: unknown }[]; models?: { name?: unknown; supportedGenerationMethods?: string[] }[] };
  if (!data || JSON.stringify(data).length > 4000000) throw new Error('模型列表格式无效');
  if ((data.data !== undefined && !Array.isArray(data.data)) || (data.models !== undefined && !Array.isArray(data.models))) throw new Error('模型列表格式无效');
  const values = config.protocol === 'gemini' ? (data.models ?? []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => typeof m.name === 'string' ? m.name.replace(/^models\//, '') : m.name) : (data.data ?? []).map(m => m.id);
  const models = [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v && v.length <= 200 && !/[\r\n]/.test(v)))].sort().slice(0, 1000);
  if (!models.length) throw new Error('未发现可用模型，请手动填写模型 ID；本次未验证工具调用能力');
  return { models, authenticated: p.requiresKey, note: `连接成功，发现 ${models.length} 个模型；工具调用能力需实际对话验证。${(data as any).has_more || (data as any).nextPageToken ? '仅显示首批模型，可手动补充。' : ''}` };
}
