import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-harness';
import type { AgentRuntime, OperationReceipt, ToolDefinition, ToolResult } from '../src/agent-types';
import type { LlmSettings } from '../src/types';

const tool: ToolDefinition = {
  name: 'inspect', description: 'Inspect a fixture', strict: true,
  parameters: { type: 'object', properties: { value: { type: 'string' }, note: { type: 'string' } }, required: ['value'], additionalProperties: false },
};
const config = (protocol: LlmSettings['protocol']): LlmSettings => ({ protocol, baseUrl: 'https://example.test/v1', model: 'fixture' });
const options = { maxSteps: 4, maxContextChars: 50_000, timeoutMs: 10_000 };

function first(protocol: LlmSettings['protocol'], name = 'inspect', args: unknown = { value: 'x' }): unknown {
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'function_call', call_id: 'call-1', name, arguments: JSON.stringify(args) }] };
  if (protocol === 'chat-completions') return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
  if (protocol === 'anthropic') return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call-1', name, input: args }] };
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thought: true, text: 'private', thoughtSignature: 'opaque-signature' }, { functionCall: { id: 'call-1', name, args } }] } }] };
}

function final(protocol: LlmSettings['protocol'], text: string): unknown {
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  if (protocol === 'chat-completions') return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
  if (protocol === 'anthropic') return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] };
}

function runtime(execute: (name: string, args: unknown) => Promise<ToolResult>): AgentRuntime {
  return { tools: [tool], receipts: [], execute };
}

describe('generic agent protocol loops', () => {
  it.each(['responses', 'chat-completions', 'anthropic', 'gemini'] as const)('feeds real tool results back through %s', async protocol => {
    const bodies: any[] = [];
    const invoked: unknown[] = [];
    const replies = [first(protocol), final(protocol, 'done')];
    const result = await runAgent(config(protocol), 'token', [{ role: 'user', content: 'inspect it' }], 'Use the available operation.', runtime(async (_name, args) => {
      invoked.push(args); return { ok: true, value: { found: 7 } };
    }), async (_url, _headers, body) => {
      bodies.push(JSON.parse(body));
      return { status: 200, json: replies.shift() };
    }, options);

    expect(result).toMatchObject({ text: 'done', receipts: [], steps: 2 });
    expect(invoked).toEqual([{ value: 'x' }]);
    if (protocol === 'responses') {
      expect(bodies[0].tools[0]).toMatchObject({ type: 'function', name: 'inspect', strict: false });
      expect(bodies[0].tools[0].parameters.required).toEqual(['value']);
      expect(bodies[0].tools[0].parameters.properties).toHaveProperty('note');
    }
    const second = bodies[1];
    if (protocol === 'responses') {
      expect(second.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call-1' });
      expect(JSON.parse(second.input.at(-1).output)).toEqual({ ok: true, value: { found: 7 } });
    } else if (protocol === 'chat-completions') {
      expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
      expect(JSON.parse(second.messages.at(-1).content)).toEqual({ ok: true, value: { found: 7 } });
    } else if (protocol === 'anthropic') {
      expect(second.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
      expect(JSON.parse(second.messages.at(-1).content[0].content)).toEqual({ ok: true, value: { found: 7 } });
    } else {
      expect(second.contents.at(-2).parts[0].thoughtSignature).toBe('opaque-signature');
      expect(second.contents.at(-1).parts[0].functionResponse).toEqual({ name: 'inspect', id: 'call-1', response: { ok: true, value: { found: 7 } } });
    }
  });

  it('executes several calls from one response sequentially and feeds every result back', async () => {
    const order: string[] = [];
    let request = 0;
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'inspect twice' }], '', runtime(async (_name, args: any) => {
      order.push(args.value); return { ok: args.value !== 'bad', ...(args.value === 'bad' ? { error: 'real failure' } : { value: args.value }) };
    }), async (_url, _headers, body) => {
      request++;
      if (request === 1) return { status: 200, json: { output: [
        { type: 'function_call', call_id: 'a', name: 'inspect', arguments: '{"value":"first"}' },
        { type: 'function_call', call_id: 'b', name: 'inspect', arguments: '{"value":"bad"}' },
      ] } };
      const payload = JSON.parse(body);
      expect(payload.input.slice(-2).map((item: any) => item.call_id)).toEqual(['a', 'b']);
      expect(JSON.parse(payload.input.at(-1).output)).toEqual({ ok: false, error: 'real failure' });
      return { status: 200, json: final('responses', 'reported') };
    }, options);
    expect(order).toEqual(['first', 'bad']);
    expect(result.text).toBe('reported');
  });

  it('returns text-only replies without writing', async () => {
    let calls = 0;
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'hello' }], '', runtime(async () => {
      calls++; return { ok: true };
    }), async () => ({ status: 200, json: final('responses', 'hello') }), options);
    expect(result).toEqual({ text: 'hello', receipts: [], steps: 1 });
    expect(calls).toBe(0);
  });

  it('retains a successful commit receipt when the following model request fails', async () => {
    const receipt: OperationReceipt = {
      operationId: 'op-1', status: 'committed', changedFiles: ['note.md'], stateChanges: [], warnings: [], undoAvailable: true, summary: 'saved',
    };
    let request = 0;
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'save' }], '', runtime(async () => ({ ok: true, receipt })), async () => {
      request++;
      if (request === 1) return { status: 200, json: first('responses') };
      throw new Error('offline');
    }, options);
    expect(result.receipts).toEqual([receipt]);
    expect(result.error).toContain('LLM request failed');
    expect(result.error?.toLowerCase()).not.toContain('no tasks were written');
  });

  it('checks cancellation after a model response and before running its tools', async () => {
    let isCancelled = false;
    let calls = 0;
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'inspect' }], '', runtime(async () => {
      calls++; return { ok: true };
    }), async () => {
      isCancelled = true;
      return { status: 200, json: first('responses') };
    }, { ...options, feedback: { cancelled: () => isCancelled } });
    expect(calls).toBe(0);
    expect(result.error).toMatch(/closed|canceled/i);
  });

  it('does not execute a last-turn tool call that cannot be fed back within maxSteps', async () => {
    let calls = 0;
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'inspect' }], '', runtime(async () => {
      calls++; return { ok: true };
    }), async () => ({ status: 200, json: first('responses') }), { ...options, maxSteps: 1 });
    expect(calls).toBe(0);
    expect(result.error).toContain('step budget exhausted before tool execution');
  });

  it('rejects malformed tool arguments without executing a tool', async () => {
    let calls = 0;
    const malformed = { output: [{ type: 'function_call', call_id: 'bad', name: 'inspect', arguments: '{' }] };
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'inspect' }], '', runtime(async () => {
      calls++; return { ok: true };
    }), async () => ({ status: 200, json: malformed }), options);
    expect(calls).toBe(0);
    expect(result.error).toContain('malformed tool argument JSON');
  });

  it('checks the context budget again before executing a returned tool call', async () => {
    let calls = 0;
    const oversized = {
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(4_000) }] },
        { type: 'function_call', call_id: 'call-1', name: 'inspect', arguments: '{"value":"x"}' },
      ],
    };
    const result = await runAgent(config('responses'), 'token', [{ role: 'user', content: 'inspect' }], '', runtime(async () => {
      calls++; return { ok: true };
    }), async () => ({ status: 200, json: oversized }), { ...options, maxContextChars: 3_000 });
    expect(calls).toBe(0);
    expect(result.error).toContain('context budget exceeded before tool execution');
  });
});
