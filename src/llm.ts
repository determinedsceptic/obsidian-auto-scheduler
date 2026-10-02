import { habitInstructions, habitTool, validateHabitDrafts } from './habit-tool';
import type { HabitDraft } from './habit-tool';
import type { LlmSettings, Settings, Task } from './types';
import { dateKey, parseBoundary, safeVaultPath } from './time';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface TaskDraft { title: string; minutes: number; priority: number; split: boolean; minMinutes: number; due: string | null; earliest: string | null }
export interface LlmReply { text: string; tasks: TaskDraft[]; habits: HabitDraft[] }
export type Transport = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; json: unknown }>;
const properties = {
  title: { type: 'string', description: 'Single-line task name without Markdown or management fields' },
  minutes: { type: 'integer', description: 'User-confirmed duration in minutes, a multiple of 15' },
  priority: { type: 'integer', enum: [1, 2, 3, 4, 5] }, split: { type: 'boolean' },
  minMinutes: { type: 'integer', description: 'Minimum block duration in minutes, a multiple of 15' },
  due: { type: ['string', 'null'], description: 'Local YYYY-MM-DD or YYYY-MM-DDTHH:mm; null if unspecified' },
  earliest: { type: ['string', 'null'], description: 'Local YYYY-MM-DD or YYYY-MM-DDTHH:mm; null if unspecified' },
};
export const taskTool = { name: 'create_tasks', description: 'Create new tasks for host validation and local scheduling. The host chooses actual times; not all work is guaranteed to fit.', strict: true,
  parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } }, required: ['tasks'], additionalProperties: false } };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model response format');
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some(k => !expected.includes(k)) || expected.some(k => !(k in value))) throw new Error('Invalid model task fields');
}
export function validateDrafts(value: unknown): TaskDraft[] {
  const args = object(value); keys(args, ['tasks']);
  if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 20) throw new Error('Create 1–20 tasks per request');
  return args.tasks.map((input: unknown) => {
    const t = object(input); keys(t, Object.keys(properties));
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 200 || /[\r\n\x00-\x1f<>\[\]%]/.test(t.title)) throw new Error('Task titles must be single-line text without management fields');
    if (!Number.isInteger(t.minutes) || t.minutes < 15 || t.minutes > 10080 || t.minutes % 15) throw new Error('Task duration must be 15–10080 minutes, in multiples of 15');
    if (!Number.isInteger(t.priority) || t.priority < 1 || t.priority > 5 || typeof t.split !== 'boolean') throw new Error('Invalid task priority or splitting settings');
    if (!Number.isInteger(t.minMinutes) || t.minMinutes < 15 || t.minMinutes > t.minutes || t.minMinutes % 15) throw new Error('Minimum blocks must be multiples of 15 minutes and no longer than the task');
    for (const field of ['due', 'earliest']) if (t[field] !== null) {
      if (typeof t[field] !== 'string' || t[field].length > 16) throw new Error('Invalid task date format');
      parseBoundary(t[field], field === 'due');
    }
    if (t.due !== null && t.earliest !== null && parseBoundary(t.due, true) <= parseBoundary(t.earliest)) throw new Error('The deadline must be after the earliest start');
    return { ...t, title: t.title.trim() } as TaskDraft;
  });
}
export function materializeTasks(drafts: TaskDraft[], settings: Settings, now: Date, batchId: string): Task[] {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(batchId)) throw new Error('Invalid task batch ID');
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
  if (!['responses', 'chat-completions', 'anthropic', 'gemini'].includes(config.protocol) || !config.model.trim() || config.model.length > 200 || /[\r\n]/.test(config.model)) throw new Error('Configure a valid protocol and model ID');
  let url: URL; try { url = new URL(config.baseUrl); } catch { throw new Error('Invalid base URL'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('The base URL must use HTTPS (HTTP is allowed for localhost) and cannot contain credentials, a query, or a fragment');
  const base = url.toString().replace(/\/$/, '');
  return base + (config.protocol === 'responses' ? '/responses' : config.protocol === 'anthropic' ? '/messages' : config.protocol === 'gemini' ? `/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent` : '/chat/completions');
}
export function authHeaders(config: LlmSettings, token: string): Record<string, string> {
  if (/[\r\n\x00-\x1f]/.test(token)) throw new Error('Invalid API key format');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (token.trim()) headers['x-api-key'] = token.trim(); }
  else if (config.protocol === 'gemini') { if (token.trim()) headers['x-goog-api-key'] = token.trim(); }
  else if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}
export async function chat(config: LlmSettings, token: string, messages: ChatMessage[], settings: Settings, now: Date, transport: Transport, timeoutMs = 60000): Promise<LlmReply> {
  const url = endpoint(config);
  if ((config.requiresKey !== false && !token.trim()) || /[\r\n]/.test(token)) throw new Error('Configure an API key in the sidebar');
  if (!messages.length || messages.length > 40 || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 12000)) throw new Error('Conversation too long. Clear the chat and try again.');
  const system = `You are an Obsidian scheduling assistant. Local date and time: ${dateKey(now)} ${now.toTimeString().slice(0, 5)}. Working days: ${settings.weekdays.join(',')} (0 is Sunday); hours: ${settings.periods.join(',')}; daily capacity: ${settings.dailyCapacity} minutes.
Use create_tasks for explicitly requested one-off tasks and create_habits for fixed-time recurring habits. Reply in the user's language; use English by default. Ask for missing durations, unclear intent, or times that do not fit the 15-minute grid. Do not invent constraints. Important means priority 4; normal means 3. Unspecified dates are null. Tasks are splittable by default, with 30-minute minimum blocks (15 for shorter tasks). Unnamed courses can be Course 1 and Course 2. Do not create anything unless the user asks. Do not promise a time or claim files have been written: the host validates, schedules, and reports actual results. You cannot delete or modify existing tasks or choose output paths. The local scheduler chooses ordinary task times; habits use the user's confirmed fixed times, including outside working hours.
${habitInstructions(settings)}`;
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
  try { response = await Promise.race([transport(url, authHeaders(config, token), JSON.stringify(body)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs); })]); }
  catch { throw new Error('LLM request failed or timed out. Check your network and provider settings. No tasks were written.'); }
  finally { if (timer) clearTimeout(timer); }
  if (response.status < 200 || response.status >= 300) throw new Error(`LLM returned HTTP ${response.status}. Check your API key, model access, and quota. No tasks were written.`);
  if (JSON.stringify(response.json).length > 1000000) throw new Error('Model response too large');
  const data = object(response.json); const calls: { name: string; arguments: string }[] = []; const texts: string[] = [];
  if (config.protocol === 'responses') {
    if (data.status && data.status !== 'completed') throw new Error('Model response incomplete. Retry with fewer tasks.');
    if (!Array.isArray(data.output)) throw new Error('Invalid Responses format');
    for (const item of data.output) {
      if (item.type === 'function_call') calls.push(item);
      if (item.type === 'message' && Array.isArray(item.content)) for (const part of item.content) if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  } else if (config.protocol === 'anthropic') {
    if (!['end_turn', 'tool_use'].includes(data.stop_reason) || !Array.isArray(data.content)) throw new Error('Incomplete or invalid Anthropic response');
    for (const part of data.content) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'tool_use') calls.push({ name: part.name, arguments: JSON.stringify(part.input) });
    }
  } else if (config.protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new Error('Gemini response incomplete or filtered');
    for (const part of candidate.content.parts) {
      if (!part.thought && typeof part.text === 'string') texts.push(part.text);
      if (part.functionCall) calls.push({ name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) });
    }
  } else {
    const choice = data.choices?.[0]; if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Model response incomplete or provider does not support tool calls');
    const message = object(choice.message); if (typeof message.content === 'string') texts.push(message.content);
    if (message.tool_calls) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.some((c: any) => c.type !== 'function')) throw new Error('Invalid model tool-call format');
      for (const call of message.tool_calls) calls.push(object(call.function) as { name: string; arguments: string });
    }
  }
  if (calls.length > 1 || calls.some(c => !['create_tasks', 'create_habits'].includes(c.name) || typeof c.arguments !== 'string')) throw new Error('The model requested an unsupported tool call');
  let tasks: TaskDraft[] = []; let habits: HabitDraft[] = [];
  if (calls.length) { let args: unknown; try { args = JSON.parse(calls[0].arguments); } catch { throw new Error('Invalid tool argument JSON'); } if (calls[0].name === 'create_habits') habits = validateHabitDrafts(args); else tasks = validateDrafts(args); }
  const text = texts.join('\n').trim();
  if (text.length > 12000) throw new Error('Model reply too long. Retry with fewer tasks.');
  if (!text && !tasks.length && !habits.length) throw new Error('The model returned no reply or action');
  return { text: text || 'Parameters received; the local scheduler will choose actual times.', tasks, habits };
}
