import { describe, it, expect } from 'vitest';
import { chat, endpoint, materializeTasks, validAiTasks, validateDrafts } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import type { Task } from '../src/types';
import { applyPreview, createPreview, undoLast } from '../src/transaction';
import { config, MemoryVault, now } from './helpers';
const draft = { title: '课程1复习', minutes: 120, priority: 4, split: true, minMinutes: 30, due: null, earliest: null };
const args = JSON.stringify({ tasks: [draft, { ...draft, title: '课程2复习' }] });
const messages = [{ role: 'user' as const, content: '两门课，每门2小时，很重要，安排一下' }];
const response = { status: 'completed', output: [{ type: 'function_call', name: 'create_tasks', arguments: args }] };
describe('LLM adapters and host validation', () => {
  it('uses Responses tools and sends no vault contents; model ID remains configurable', async () => {
    const reply = await chat(DEFAULT_LLM, 'test-only', messages, config(), now, async (url, headers, body) => {
      expect(url).toBe('https://api.openai.com/v1/responses'); expect(headers.Authorization).toBe('Bearer test-only');
      const data = JSON.parse(body); expect(data.model).toBe('gpt-6-luna'); expect(data.store).toBe(false);
      expect(data.max_output_tokens).toBe(2048); expect(data.reasoning.effort).toBe('none');
      expect(data.tools[0].name).toBe('create_tasks'); expect(data.tools[0].parameters.additionalProperties).toBe(false);
      expect(body).not.toContain('Tasks/A.md'); return { status: 200, json: response };
    });
    expect(reply.tasks.map(t => t.minutes)).toEqual([120, 120]);
    expect(materializeTasks(reply.tasks, config(), now, 'example').map(t => t.id)).toEqual(['ai_example_1', 'ai_example_2']);
  });
  it('supports compatible Chat Completions and arbitrary model IDs', async () => {
    const reply = await chat({ protocol: 'chat-completions', baseUrl: 'https://example.test/v1/', model: 'other-model' }, 'test-only', messages, config(), now, async (url, _, body) => {
      const data = JSON.parse(body); expect(url).toBe('https://example.test/v1/chat/completions'); expect(data.model).toBe('other-model'); expect(data.tools[0].function.name).toBe('create_tasks');
      return { status: 200, json: { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'create_tasks', arguments: args } }] } }] } };
    }); expect(reply.tasks).toHaveLength(2);
  });
  it('sets GPT-6 Chat Completions reasoning to none for function calling', async () => {
    await chat({ ...DEFAULT_LLM, protocol: 'chat-completions' }, 'test-only', messages, config(), now, async (_, __, body) => {
      expect(JSON.parse(body).reasoning_effort).toBe('none'); return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '想在哪天复习？' } }] } };
    });
  });
  it('accepts clarifying replies without creating tasks', async () => {
    const reply = await chat(DEFAULT_LLM, 'test-only', messages, config(), now, async () => ({ status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: '每门课要多久？' }] }] } }));
    expect(reply.tasks).toEqual([]); expect(reply.text).toContain('多久');
  });
  it.each([
    { ...draft, path: '../secret.md' }, { ...draft, title: 'foo\n# hacked' }, { ...draft, title: '<!-- as id=x -->' },
    { ...draft, title: '[[secret]]' }, { ...draft, minutes: 121 }, { ...draft, minutes: 0 }, { ...draft, priority: 9 },
    { ...draft, minMinutes: 135 }, { ...draft, due: '2026-02-30' }, { ...draft, due: '2026-10-02', earliest: '2026-10-03' },
  ])('rejects invalid or injected task fields %j', item => { expect(() => validateDrafts({ tasks: [item] })).toThrow(); });
  it('rejects excessive task batches and invalid stored AI tasks', () => {
    expect(() => validateDrafts({ tasks: Array(21).fill(draft) })).toThrow();
    const tasks = materializeTasks([draft], config(), now, 'example'); expect(validAiTasks(tasks)).toBe(true);
    expect(validAiTasks([...tasks, ...tasks])).toBe(false); expect(validAiTasks([{ ...tasks[0], path: '../secret.md' }])).toBe(false);
  });
  it.each(['http://example.test/v1', 'https://key@example.test/v1', 'https://example.test/v1?token=abc', 'https://example.test/v1#token'])('rejects unsafe endpoint %s', baseUrl => { expect(() => endpoint({ ...DEFAULT_LLM, baseUrl })).toThrow(); });
  it('permits local HTTP endpoints', () => { expect(endpoint({ ...DEFAULT_LLM, baseUrl: 'http://localhost:1234/v1' })).toContain('localhost:1234'); });
  it('does not expose tokens or server bodies on failed requests', async () => {
    await expect(chat(DEFAULT_LLM, 'private-token', messages, config(), now, async () => { throw new Error('private-token'); })).rejects.toThrow('LLM request failed');
    await expect(chat(DEFAULT_LLM, 'private-token', messages, config(), now, async () => ({ status: 401, json: { error: 'private-token' } }))).rejects.toThrow('HTTP 401');
  });
  it('handles timeout and incomplete responses before any task creation', async () => {
    await expect(chat(DEFAULT_LLM, 'test-only', messages, config(), now, () => new Promise(() => {}), 5)).rejects.toThrow('timed out');
    await expect(chat(DEFAULT_LLM, 'test-only', messages, config(), now, async () => ({ status: 200, json: { ...response, status: 'incomplete' } }))).rejects.toThrow('incomplete');
  });
  it('rejects unknown, multiple and malformed tool calls', async () => {
    for (const output of [ [{ type: 'function_call', name: 'delete_file', arguments: args }], [...response.output, ...response.output], [{ ...response.output[0], arguments: 'broken json' }] ]) {
      await expect(chat(DEFAULT_LLM, 'test-only', messages, config(), now, async () => ({ status: 200, json: { output } }))).rejects.toThrow();
    }
  });
});
class AiVault extends MemoryVault {
  aiTasks: Task[] = [];
  getAiTasks(): Task[] { return this.aiTasks; }
  override async saveUndo(record: Parameters<MemoryVault['saveUndo']>[0], tracking?: Parameters<MemoryVault['saveUndo']>[1], tasks?: Task[]): Promise<void> {
    await super.saveUndo(record, tracking); if (tasks) this.aiTasks = structuredClone(tasks);
  }
}
describe('AI tasks daily transaction', () => {
  const settings = config({ outputLocation: 'daily', outputMode: 'day-planner', cleanDaily: true });
  it('creates two courses as pure daily lists; persists, replans and undoes after restart', async () => {
    const vault = new AiVault(); vault.files = {};
    const tasks = materializeTasks([draft, { ...draft, title: '课程2复习' }], settings, now, 'courses');
    const preview = await createPreview(vault, settings, now, {}, false, [], tasks);
    expect(preview.result.errors).toEqual([]); expect(vault.aiTasks).toEqual([]); expect(vault.writes).toBe(0);
    await applyPreview(vault, vault, preview, settings, now); expect(vault.aiTasks).toHaveLength(2);
    for (const file of Object.values(vault.files)) { expect(file).toContain('# Day planner'); expect(file).not.toMatch(/<!--|\[scheduled::|auto-scheduler:|\[\[/); }
    expect(Object.values(vault.files).join('\n')).toContain('课程1复习');
    const restarted = new AiVault(); restarted.files = structuredClone(vault.files); restarted.tracking = structuredClone(vault.tracking); restarted.aiTasks = structuredClone(vault.aiTasks); restarted.undo = structuredClone(vault.undo);
    const repeat = await createPreview(restarted, settings, now, restarted.tracking, false, restarted.aiTasks); expect(repeat.result.errors).toEqual([]); expect(repeat.diff.added).toHaveLength(0);
    await expect(applyPreview(restarted, restarted, preview, settings, now)).rejects.toThrow('changed');
    await undoLast(restarted, restarted, restarted.undo); expect(restarted.aiTasks).toEqual([]); expect(Object.values(restarted.files).join('')).not.toContain('课程');
  });
  it('does not recreate completed AI work after the daily window advances', async () => {
    const vault = new AiVault(); vault.files = {};
    const tasks = materializeTasks([draft], settings, now, 'history');
    const preview = await createPreview(vault, settings, now, {}, false, [], tasks);
    await applyPreview(vault, vault, preview, settings, now);
    vault.files['DailyNotes/2026-10-01.md'] = vault.files['DailyNotes/2026-10-01.md'].replace('- [ ]', '- [x]');
    const next = await createPreview(vault, settings, new Date('2026-10-02T08:00:00+08:00'), vault.tracking, false, vault.aiTasks);
    expect(next.result.errors).toEqual([]); expect(next.result.blocks).toEqual([]); expect(next.result.unscheduled).toEqual([]);
  });
  it('retains AI tasks and undo when file write fails, then restores both', async () => {
    const vault = new AiVault(); vault.files = {}; vault.failWrite = true;
    const tasks = materializeTasks([draft], settings, now, 'failure');
    const preview = await createPreview(vault, settings, now, {}, false, [], tasks);
    await expect(applyPreview(vault, vault, preview, settings, now)).rejects.toThrow('write failed'); expect(vault.aiTasks).toHaveLength(1); expect(vault.undo).not.toBeNull();
    vault.failWrite = false; await undoLast(vault, vault, vault.undo); expect(vault.aiTasks).toEqual([]);
  });
  it('rejects changed AI state and a batch with no available capacity', async () => {
    const vault = new AiVault(); vault.files = {};
    const tasks = materializeTasks([draft], settings, now, 'conflict');
    const preview = await createPreview(vault, settings, now, {}, false, [], tasks); vault.aiTasks = tasks;
    await expect(applyPreview(vault, vault, preview, settings, now)).rejects.toThrow('AI tasks changed'); vault.aiTasks = [];
    const noWork = { ...settings, weekdays: [0], periods: ['09:00-09:15'], dailyCapacity: 15 };
    const blocked = await createPreview(vault, noWork, now, {}, false, [], tasks);
    await expect(applyPreview(vault, vault, blocked, noWork, now)).rejects.toThrow('No blocks can be written'); expect(vault.aiTasks).toEqual([]);
  });
});

it.each(['responses','chat-completions','anthropic','gemini'] as const)('uses a host default for flexible tasks through %s without asking duration/date',async protocol=>{
  const tasks=[{title:'Get a phone number',minutes:null,priority:3,split:true,minMinutes:null,due:null,earliest:null}];
  const call={name:'create_tasks',arguments:JSON.stringify({tasks})};
  const json=protocol==='responses'?{output:[{type:'function_call',...call}]}:protocol==='chat-completions'?{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:call}]}}]}:protocol==='anthropic'?{stop_reason:'tool_use',content:[{type:'tool_use',name:call.name,input:{tasks}}]}:{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:call.name,args:{tasks}}}]}}]};
  const r=await chat({protocol,baseUrl:'https://example.test/v1',model:'fixture'},'test-only',messages,config({defaultEventDuration:45}),now,async(_,__,body)=>{
    expect(body).toContain('Do not ask for a duration or date merely because it is missing');return {status:200,json};
  });
  expect(r.tasks[0]).toMatchObject({minutes:45,minMinutes:30,due:null,earliest:null});expect(r.defaultsUsed).toEqual(['Get a phone number']);
});
it('removes noncharacters, private-use glyphs, broken surrogates and replacement characters from model prose',async()=>{
  const r=await chat(DEFAULT_LLM,'test-only',messages,config(),now,async()=>({status:200,json:{output:[{type:'message',content:[{type:'output_text',text:'安排健身 🏋️ 19:00\u{5ffff}\u{e000}\ud800\ufffd'}]}]}}));
  expect(r.text).toBe('安排健身 🏋️ 19:00');
});

it('validates a mixed plan with a default-duration task and an undated exact event',async()=>{
  const plan={tasks:[{title:'Phone number',minutes:null,minMinutes:null,priority:3,split:true,due:null,earliest:null}],events:[{title:'Gym',date:null,start:'11:30',minutes:60}],habits:[]};
  const r=await chat(DEFAULT_LLM,'test-only',messages,config(),now,async()=>({status:200,json:{output:[{type:'function_call',name:'create_plan',arguments:JSON.stringify(plan)}]}}));
  expect(r.tasks[0].minutes).toBe(30);expect(r.events[0].date).toBeNull();expect(r.events[0].minutes).toBe(60);expect(r.defaultsUsed).toEqual(['Phone number']);
  await expect(chat(DEFAULT_LLM,'test-only',messages,config(),now,async()=>({status:200,json:{output:[{type:'function_call',name:'create_plan',arguments:JSON.stringify({tasks:[],habits:[],events:[]})}]}}))).rejects.toThrow('at least one');
});

it('retains estimated total effort and assumptions instead of using the errand default',()=>{
  const basis='暂按300页、每小时30页估算：300÷30=10小时';
  const tasks=validateDrafts({tasks:[{...draft,title:'读一本书',minutes:600,estimateBasis:basis}]});
  expect(tasks[0].minutes).toBe(600);expect(tasks[0].estimateBasis).toBe(basis);
  expect(materializeTasks(tasks,config(),now,'book')[0].remaining).toBe(600);
  expect(()=>validateDrafts({tasks:[{...draft,minutes:null,estimateBasis:basis}]})).toThrow('explicit minutes');
});
