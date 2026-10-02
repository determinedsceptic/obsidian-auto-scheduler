import { habitInstructions, habitTool, validateHabitDrafts } from './habit-tool';
import type { HabitDraft } from './habit-tool';
import type { LlmSettings, Settings, Task } from './types';
import { dateKey, parseBoundary, safeVaultPath } from './time';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface TaskDraft { title: string; minutes: number; priority: number; split: boolean; minMinutes: number; due: string | null; earliest: string | null }
export interface LlmReply { text: string; tasks: TaskDraft[]; habits: HabitDraft[] }
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; json: unknown }>;
const properties = {
  title: { type: 'string', description: '单行任务名称，不含 Markdown 或管理字段' },
  minutes: { type: 'integer', description: '用户确认的预计用时（分钟），15 的倍数' },
  priority: { type: 'integer', enum: [1, 2, 3, 4, 5] }, split: { type: 'boolean' },
  minMinutes: { type: 'integer', description: '最小工作块分钟数，15 的倍数' },
  due: { type: ['string', 'null'], description: '本地 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，未指定为 null' },
  earliest: { type: ['string', 'null'], description: '本地 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，未指定为 null' },
};
export const taskTool = { name: 'create_tasks', description: '生成新任务供宿主校验并自动排程；实际时间由本地排程器决定，不保证全部能安排。', strict: true,
  parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } }, required: ['tasks'], additionalProperties: false } };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回格式无效');
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some(k => !expected.includes(k)) || expected.some(k => !(k in value))) throw new Error('模型任务字段无效');
}
export function validateDrafts(value: unknown): TaskDraft[] {
  const args = object(value); keys(args, ['tasks']);
  if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 20) throw new Error('一次需生成 1–20 个任务');
  return args.tasks.map((input: unknown) => {
    const t = object(input); keys(t, Object.keys(properties));
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%]/.test(t.title)) throw new Error('任务标题需为不含管理字段的单行文本');
    if (!Number.isInteger(t.minutes) || t.minutes < 15 || t.minutes > 10080 || t.minutes % 15) throw new Error('任务用时需为 15–10080 分钟，且为 15 的倍数');
    if (!Number.isInteger(t.priority) || t.priority < 1 || t.priority > 5 || typeof t.split !== 'boolean') throw new Error('任务优先级或拆分设置无效');
    if (!Number.isInteger(t.minMinutes) || t.minMinutes < 15 || t.minMinutes > t.minutes || t.minMinutes % 15) throw new Error('最小工作块需为 15 分钟倍数，且不超过任务用时');
    for (const field of ['due', 'earliest']) if (t[field] !== null) {
      if (typeof t[field] !== 'string' || t[field].length > 16) throw new Error('任务日期格式无效');
      parseBoundary(t[field], field === 'due');
    }
    if (t.due !== null && t.earliest !== null && parseBoundary(t.due, true) <= parseBoundary(t.earliest)) throw new Error('截止时间必须晚于最早开始时间');
    return { ...t, title: t.title.trim() } as TaskDraft;
  });
}
export function materializeTasks(drafts: TaskDraft[], settings: Settings, now: Date, batchId: string): Task[] {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(batchId)) throw new Error('任务批次 ID 无效');
  const checked = validateDrafts({ tasks: drafts });
  return checked.map((t, i) => ({ id: `ai_${batchId}_${i + 1}`, title: t.title,
    path: `${settings.dailyFolder}/${dateKey(now)}.md`, line: 0, remaining: t.minutes, priority: t.priority,
    split: t.split, min: t.minMinutes, completed: false,
    ...(t.due === null ? {} : { due: parseBoundary(t.due, true) }),
    ...(t.earliest === null ? {} : { earliest: parseBoundary(t.earliest) }),
  }));
}
export function validAiTasks(value: unknown): value is Task[] {
  return Array.isArray(value) && value.length <= 10000 && new Set(value.map(t => t?.id)).size === value.length && value.every(t =>
    t && /^ai_[a-zA-Z0-9_-]+$/.test(t.id) && safeVaultPath(t.path) && t.path.endsWith('.md') && t.line === 0 && typeof t.completed === 'boolean'
    && [t.due, t.earliest].every(n => n === undefined || Number.isFinite(n)) && (() => {
      try { validateDrafts({ tasks: [{ title: t.title, minutes: t.remaining, priority: t.priority, split: t.split, minMinutes: t.min, due: null, earliest: null }] }); return true; } catch { return false; }
    })());
}
export function endpoint(config: LlmSettings): string {
  if (!['responses', 'chat-completions', 'anthropic', 'gemini'].includes(config.protocol) || !config.model.trim() || config.model.length > 200 || /[\r\n]/.test(config.model)) throw new Error('请配置有效的接口和模型 ID');
  let url: URL; try { url = new URL(config.baseUrl); } catch { throw new Error('Base URL 无效'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Base URL 必须使用 HTTPS（本机可用 HTTP），且不能包含令牌、查询参数或片段');
  const base = url.toString().replace(/\/$/, '');
  return base + (config.protocol === 'responses' ? '/responses' : config.protocol === 'anthropic' ? '/messages' : config.protocol === 'gemini' ? `/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent` : '/chat/completions');
}
export function authHeaders(config: LlmSettings, token: string): Record<string, string> {
  if (/[\r\n\x00-\x1f]/.test(token)) throw new Error('API 令牌格式无效');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (token.trim()) headers['x-api-key'] = token.trim(); }
  else if (config.protocol === 'gemini') { if (token.trim()) headers['x-goog-api-key'] = token.trim(); }
  else if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}
export async function chat(config: LlmSettings, token: string, messages: ChatMessage[], settings: Settings, now: Date, transport: Transport, timeoutMs = 60000): Promise<LlmReply> {
  const url = endpoint(config);
  if ((config.requiresKey !== false && !token.trim()) || /[\r\n]/.test(token)) throw new Error('请在侧栏填写 API 令牌');
  if (!messages.length || messages.length > 40 || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 12000)) throw new Error('对话过长，请清空对话后重试');
  const system = `你是 Obsidian 任务助手。当前本地日期时间 ${dateKey(now)} ${now.toTimeString().slice(0, 5)}。工作日 ${settings.weekdays.join(',')}（0周日）；时段 ${settings.periods.join(',')}；每日容量 ${settings.dailyCapacity} 分钟。允许 create_tasks 创建单次任务，create_habits 创建周期习惯。用中文回复；缺少用时、意图不明确或不满足15分钟网格时先问用户，不自行猜测。重要=优先级4，普通=3。未指定日期设null；可拆分默认true，最小块默认30分钟（任务不足30则15）。课程未命名可用课程1、课程2。用户没有请求创建时只对话。不要猜测或承诺具体安排和已写入：工具只生成任务参数，宿主校验、排程、写入后会给出实际结果。不能删除、修改现有任务或指定输出路径，时段由本地排程器决定。\n${habitInstructions(settings)}`;
  const tools = [taskTool, habitTool];
  const body = config.protocol === 'responses' ? { model: config.model, instructions: system, input: messages, tools: tools.map(tool => ({ type: 'function', ...tool })), parallel_tool_calls: false, store: false, max_output_tokens: 4096 }
    : config.protocol === 'anthropic' ? { model: config.model, system, messages, max_tokens: 4096,
      tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
    : config.protocol === 'gemini' ? { systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }], generationConfig: { maxOutputTokens: 4096 } }
    : { model: config.model, messages: [{ role: 'system', content: system }, ...messages], tools: tools.map(tool => ({ type: 'function', function: tool })), parallel_tool_calls: false,
      ...(config.model.startsWith('gpt-6') ? { reasoning_effort: 'none', max_completion_tokens: 4096 } : { max_tokens: 4096 }) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Awaited<ReturnType<Transport>>;
  try { response = await Promise.race([transport(url, authHeaders(config, token), JSON.stringify(body)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('请求超时')), timeoutMs); })]); }
  catch { throw new Error('LLM 请求失败或超时，请检查网络、接口配置后重试；未写入任务'); }
  finally { if (timer) clearTimeout(timer); }
  if (response.status < 200 || response.status >= 300) throw new Error(`LLM 接口返回 HTTP ${response.status}，请检查令牌、模型权限和额度；未写入任务`);
  if (JSON.stringify(response.json).length > 1000000) throw new Error('模型返回内容过大');
  const data = object(response.json); const calls: { name: string; arguments: string }[] = []; const texts: string[] = [];
  if (config.protocol === 'responses') {
    if (data.status && data.status !== 'completed') throw new Error('模型响应未完成，请重试或减少任务数量');
    if (!Array.isArray(data.output)) throw new Error('Responses 返回格式无效');
    for (const item of data.output) {
      if (item.type === 'function_call') calls.push(item);
      if (item.type === 'message' && Array.isArray(item.content)) for (const part of item.content) if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  } else if (config.protocol === 'anthropic') {
    if (!['end_turn', 'tool_use'].includes(data.stop_reason) || !Array.isArray(data.content)) throw new Error('Anthropic 响应未完成或格式无效');
    for (const part of data.content) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'tool_use') calls.push({ name: part.name, arguments: JSON.stringify(part.input) });
    }
  } else if (config.protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new Error('Gemini 响应未完成或被过滤');
    for (const part of candidate.content.parts) {
      if (!part.thought && typeof part.text === 'string') texts.push(part.text);
      if (part.functionCall) calls.push({ name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) });
    }
  } else {
    const choice = data.choices?.[0]; if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('模型响应未完成或接口不支持工具调用');
    const message = object(choice.message); if (typeof message.content === 'string') texts.push(message.content);
    if (message.tool_calls) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.some((c: any) => c.type !== 'function')) throw new Error('模型工具调用格式无效');
      for (const call of message.tool_calls) calls.push(object(call.function) as { name: string; arguments: string });
    }
  }
  if (calls.length > 1 || calls.some(c => !['create_tasks', 'create_habits'].includes(c.name) || typeof c.arguments !== 'string')) throw new Error('模型请求了不支持的工具调用');
  let tasks: TaskDraft[] = []; let habits: HabitDraft[] = [];
  if (calls.length) { let args: unknown; try { args = JSON.parse(calls[0].arguments); } catch { throw new Error('模型任务 JSON 无效'); } if (calls[0].name === 'create_habits') habits = validateHabitDrafts(args); else tasks = validateDrafts(args); }
  const text = texts.join('\n').trim();
  if (text.length > 12000) throw new Error('模型回复过长，请减少任务数量后重试');
  if (!text && !tasks.length && !habits.length) throw new Error('模型未返回回复或任务');
  return { text: text || '任务参数已生成，由本地排程器安排时间。', tasks, habits };
}
