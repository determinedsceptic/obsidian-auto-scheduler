import type { ToolCall, ToolDefinition, ToolResult } from './agent-types';
import type { LlmSettings } from './types';

export interface AgentMessage { role: 'user' | 'assistant'; content: string }

export interface ProtocolState {
  readonly protocol: LlmSettings['protocol'];
  readonly body: Record<string, any>;
  turn: number;
}

export interface ProtocolTurn {
  text: string;
  calls: ToolCall[];
  /** Provider-native assistant content, retained so opaque metadata round-trips. */
  native: unknown;
  /** Native call IDs are optional only for Gemini. */
  nativeCallIds: Array<string | undefined>;
}

function record(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function toolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new Error('Model returned malformed tool argument JSON'); }
}

function toolSchemas(protocol: LlmSettings['protocol'], tools: ToolDefinition[]): unknown {
  // Host schemas may intentionally contain optional fields. Do not opt providers
  // into their stricter all-properties-required dialect here.
  const portable = tools.map(({ strict: _strict, ...tool }) => tool);
  if (protocol === 'responses') return portable.map(tool => ({ type: 'function', ...tool, strict: false }));
  if (protocol === 'anthropic') return tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  if (protocol === 'gemini') return [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }];
  return portable.map(tool => ({ type: 'function', function: tool }));
}

export function createProtocolRequest(
  config: LlmSettings,
  system: string,
  messages: AgentMessage[],
  tools: ToolDefinition[],
): ProtocolState {
  const copied = messages.map(message => ({ ...message }));
  const body: Record<string, any> = config.protocol === 'responses'
    ? {
        model: config.model, instructions: system, input: copied,
        tools: toolSchemas(config.protocol, tools), parallel_tool_calls: false,
        store: false, max_output_tokens: 4096,
        ...(config.model === 'gpt-6-luna' ? { reasoning: { effort: 'none' } } : {}),
      }
    : config.protocol === 'anthropic'
      ? { model: config.model, system, messages: copied, max_tokens: 4096, tools: toolSchemas(config.protocol, tools) }
      : config.protocol === 'gemini'
        ? {
            systemInstruction: { parts: [{ text: system }] },
            contents: copied.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
            tools: toolSchemas(config.protocol, tools), generationConfig: { maxOutputTokens: 4096 },
          }
        : {
            model: config.model, messages: [{ role: 'system', content: system }, ...copied],
            tools: toolSchemas(config.protocol, tools), parallel_tool_calls: false,
            ...(config.model.startsWith('gpt-6') ? { reasoning_effort: 'none', max_completion_tokens: 4096 } : { max_tokens: 4096 }),
          };
  return { protocol: config.protocol, body, turn: 0 };
}

function cleanText(text: string): string {
  return text.replace(/[\p{Co}\p{Cs}\p{Cn}\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu, '');
}

function checkedCall(id: unknown, name: unknown, args: unknown, allowGeneratedId?: string): ToolCall {
  if (typeof name !== 'string' || !name || name.length > 200) throw new Error('Model returned an invalid tool name');
  const callId = typeof id === 'string' && id ? id : allowGeneratedId;
  if (!callId) throw new Error('Provider omitted the tool call ID');
  return { id: callId, name, arguments: toolArguments(args) };
}

export function parseProtocolResponse(state: ProtocolState, value: unknown): ProtocolTurn {
  const data = record(value, 'Invalid provider response');
  const calls: ToolCall[] = [];
  const nativeCallIds: Array<string | undefined> = [];
  const texts: string[] = [];
  let native: unknown;

  if (state.protocol === 'responses') {
    if (data.status && data.status !== 'completed') throw new Error('Model response incomplete');
    if (!Array.isArray(data.output)) throw new Error('Invalid Responses API response');
    native = data.output;
    for (const itemValue of data.output) {
      const item = record(itemValue, 'Invalid Responses API output item');
      if (item.type === 'function_call') {
        calls.push(checkedCall(item.call_id, item.name, item.arguments));
        nativeCallIds.push(item.call_id);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      }
    }
  } else if (state.protocol === 'anthropic') {
    if (!['end_turn', 'tool_use'].includes(data.stop_reason) || !Array.isArray(data.content)) throw new Error('Incomplete or invalid Anthropic response');
    native = data.content;
    for (const partValue of data.content) {
      const part = record(partValue, 'Invalid Anthropic content block');
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (part.type === 'tool_use') {
        calls.push(checkedCall(part.id, part.name, part.input));
        nativeCallIds.push(part.id);
      }
    }
  } else if (state.protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new Error('Gemini response incomplete or filtered');
    // Keep the complete content object, including opaque thoughtSignature fields.
    native = candidate.content;
    let callIndex = 0;
    for (const partValue of candidate.content.parts) {
      const part = record(partValue, 'Invalid Gemini content part');
      if (!part.thought && typeof part.text === 'string') texts.push(part.text);
      if (part.functionCall) {
        const fc = record(part.functionCall, 'Invalid Gemini function call');
        const nativeId = typeof fc.id === 'string' && fc.id ? fc.id : undefined;
        calls.push(checkedCall(nativeId, fc.name, fc.args, `gemini-${state.turn + 1}-${callIndex + 1}`));
        nativeCallIds.push(nativeId);
        callIndex++;
      }
    }
  } else {
    const choice = data.choices?.[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Model response incomplete or provider does not support tool calls');
    const message = record(choice.message, 'Invalid Chat Completions message');
    native = message;
    if (typeof message.content === 'string') texts.push(message.content);
    else if (Array.isArray(message.content)) for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new Error('Invalid Chat Completions tool calls');
      for (const callValue of message.tool_calls) {
        const call = record(callValue, 'Invalid Chat Completions tool call');
        if (call.type !== 'function') throw new Error('Invalid Chat Completions tool-call type');
        const fn = record(call.function, 'Invalid Chat Completions function call');
        calls.push(checkedCall(call.id, fn.name, fn.arguments));
        nativeCallIds.push(call.id);
      }
    }
  }

  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Provider returned duplicate tool call IDs');
  state.turn++;
  return { text: cleanText(texts.join('\n')).trim(), calls, native, nativeCallIds };
}

function serializedResult(result: ToolResult): string {
  try { return JSON.stringify(result); }
  catch { return JSON.stringify({ ok: false, error: 'Tool result was not serializable' }); }
}

export function appendProtocolResults(state: ProtocolState, turn: ProtocolTurn, results: ToolResult[]): void {
  if (turn.calls.length !== results.length) throw new Error('A tool result is required for every tool call');
  if (state.protocol === 'responses') {
    if (!Array.isArray(turn.native)) throw new Error('Invalid native Responses content');
    state.body.input.push(...turn.native, ...turn.calls.map((call, i) => ({ type: 'function_call_output', call_id: call.id, output: serializedResult(results[i]) })));
  } else if (state.protocol === 'anthropic') {
    state.body.messages.push(
      { role: 'assistant', content: turn.native },
      { role: 'user', content: turn.calls.map((call, i) => ({ type: 'tool_result', tool_use_id: call.id, content: serializedResult(results[i]), ...(results[i].ok ? {} : { is_error: true }) })) },
    );
  } else if (state.protocol === 'gemini') {
    state.body.contents.push(
      turn.native,
      {
        role: 'user',
        parts: turn.calls.map((call, i) => ({
          functionResponse: {
            name: call.name,
            ...(turn.nativeCallIds[i] ? { id: turn.nativeCallIds[i] } : {}),
            response: results[i],
          },
        })),
      },
    );
  } else {
    state.body.messages.push(
      turn.native,
      ...turn.calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: serializedResult(results[i]) })),
    );
  }
}
