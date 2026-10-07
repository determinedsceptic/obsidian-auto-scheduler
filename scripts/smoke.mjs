// Host API simulation only. Never reads or writes a real Obsidian vault or API.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';

process.env.TZ = 'Asia/Shanghai';
const fixedDate = '2026-10-01T08:00:00+08:00';
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedDate])); }
  static now() { return new Date(fixedDate).getTime(); }
}

const notices = [], requests = [], openedNotes = [], clipboardCopies = [];
let saved = null, latestModal, mockStatus = 200, mockHttp, activeFile = null;

class Node {
  constructor(tag = '', options = {}) { this.tag = tag; this.options = options; this.children = []; this.events = {}; this.value = options.value ?? ''; }
  createEl(tag, options = {}) { const node = new Node(tag, options); this.children.push(node); return node; }
  createDiv(options = {}) { return this.createEl('div', options); }
  createSpan(options = {}) { return this.createEl('span', options); }
  addEventListener(name, callback) { this.events[name] = callback; }
  addClass() {}
  replaceChildren() { this.children = []; }
  querySelectorAll() { return this.all().filter(node => ['input', 'select', 'textarea'].includes(node.tag)); }
  empty() { this.children = []; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
class Setting {
  constructor(container) { this.node = container.createDiv(); }
  setName(name) { this.node.options.settingName = name; return this; }
  setDesc() { return this; }
  control(tag, callback, property) {
    const node = this.node.createEl(tag);
    const control = { [property]: node, setValue(value) { node.value = value; return this; }, onChange(fn) { node.events.change = () => fn(node.value); return this; }, setDisabled(value) { node.disabled = value; return this; }, addOption(value, text) { node.createEl('option', { value, text }); return this; } };
    callback(control); return this;
  }
  addDropdown(callback) { return this.control('select', callback, 'selectEl'); }
  addText(callback) { return this.control('input', callback, 'inputEl'); }
  addTextArea(callback) { return this.control('textarea', callback, 'inputEl'); }
  addToggle(callback) { return this.control('input', callback, 'toggleEl'); }
}
class TFile { constructor(path) { this.path = path; } }
class TFolder { constructor(path) { this.path = path; } }
class Plugin {
  constructor(app) { this.app = app; this.commands = []; this.views = new Map(); }
  async loadData() { return saved; }
  async saveData(value) { saved = structuredClone(value); }
  registerView(type, factory) { this.views.set(type, factory); }
  addCommand(command) { this.commands.push(command); }
  addRibbonIcon() {}
  addSettingTab() {}
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Node(); this.modalEl = new Node(); }
  open() { latestModal = this; this.onOpen(); }
  close() { this.onClose(); }
}

const module = { exports: {} };
vm.runInNewContext(await readFile('main.js', 'utf8'), {
  navigator: { clipboard: { writeText: async text => { clipboardCopies.push(text); } } },
  module, exports: module.exports, Date: Clock, Intl, console, structuredClone,
  crypto: webcrypto, URL, AbortController, setTimeout, clearTimeout,
  require: name => {
    assert.equal(name, 'obsidian', 'Unexpected runtime dependency');
    return {
      Plugin, Modal, ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = new Node(); } },
      TFile, TFolder, PluginSettingTab: class {}, Setting,
      requestUrl: async request => { requests.push(request); if (mockHttp) return mockHttp(request); return { status: mockStatus, json: {} }; },
      Notice: class { constructor(text) { notices.push(text); } }, normalizePath: path => path,
    };
  },
});
const AutoScheduler = module.exports.default;
assert.equal(typeof AutoScheduler, 'function');

const files = new Map(), folders = new Set();
let creates = 0, processes = 0;
const app = {
  workspace: {
    getLeavesOfType: () => [], getActiveFile: () => activeFile, openLinkText: async () => {},
    getLeaf: () => ({ openFile: async file => { openedNotes.push(file.path); } }),
  },
  vault: {
    getAbstractFileByPath: path => files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
    getMarkdownFiles: () => [...files.keys()].map(path => new TFile(path)), read: async file => files.get(file.path),
    createFolder: async path => { folders.add(path); },
    create: async (path, text) => { assert(!files.has(path)); files.set(path, text); creates++; },
    process: async (file, callback) => { const text = callback(files.get(file.path)); files.set(file.path, text); processes++; return text; },
  },
};

const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const prose = text => ({ status: 200, json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
const postCount = () => requests.filter(request => request.method === 'POST').length;
const toolResult = (body, id) => {
  const item = [...body.input].reverse().find(value => value.type === 'function_call_output' && value.call_id === id);
  assert(item, `Missing tool result ${id}`); return JSON.parse(item.output);
};
const modelList = request => request.method === 'GET' ? { status: 200, json: { data: [{ id: 'fixture' }, { id: 'fixture-pro' }] } } : null;
const assistantMessages = view => view.messages.filter(message => message.role === 'assistant');

// Offline commands, preview/apply, settings, restart, and local undo.
// Use the public habit format here; generic note organization is covered below.
const offlineHabit = '- 19:00-19:30 ⏫ Offline preview habit（每天）';
files.set('Habits/Habit template.md', offlineHabit); folders.add('Habits');
const plugin = new AutoScheduler(app); await plugin.onload(); assert.equal(plugin.commands.length, 9);
mockStatus = 401; await plugin.checkApiConnection(); assert.equal(requests.at(-1).method, 'GET'); assert.equal(requests.at(-1).headers, undefined); assert(notices.some(text => text.includes('HTTP 401')));
await plugin.updateSettings({ outputFile: 'Scheduler/Smoke.md' });
plugin.commands.find(command => command.id === 'preview-week').callback(); await plugin.operations.tail;
const apply = latestModal.contentEl.all().find(node => node.options.text === 'Apply schedule'); assert(apply && !apply.disabled); apply.events.click(); await plugin.operations.tail;
assert(files.get('Scheduler/Smoke.md').includes('Offline preview habit')); assert(saved.undo);
const restarted = new AutoScheduler(app); await restarted.onload(); assert.equal(restarted.state.settings.outputFile, 'Scheduler/Smoke.md');
restarted.commands.find(command => command.id === 'undo-last').callback(); await restarted.operations.tail;
assert.equal(saved.undo, null); assert(!files.get('Scheduler/Smoke.md').includes('Offline preview habit')); assert.equal(files.get('Habits/Habit template.md'), offlineHabit);
console.log('PASS: offline command registration, credential-free connection check, preview/apply, persisted config, restart, local undo');

// Provider configuration keeps session credentials out of durable state and rolls back on save failure.
await restarted.saveProvider({ id: 'fixture-provider', name: 'Fixture', protocol: 'responses', baseUrl: 'https://example.test/v1', requiresKey: false, models: ['fixture', 'fixture-pro'] }, 'session-token', 'fixture-pro');
assert.equal(restarted.state.llm.model, 'fixture-pro'); assert.equal(await restarted.getApiToken(), 'session-token'); assert(!JSON.stringify(saved).includes('session-token'));
const durableBeforeFailure = JSON.stringify(restarted.state), saveData = restarted.saveData.bind(restarted);
restarted.saveData = async () => { throw new Error('disk unavailable'); };
await assert.rejects(restarted.saveProvider({ id: 'rollback', name: 'Rollback', protocol: 'responses', baseUrl: 'https://example.test/v1', requiresKey: true, models: ['fixture'] }, 'new-secret'), /previous key was restored/);
assert.equal(JSON.stringify(restarted.state), durableBeforeFailure); assert.equal(await restarted.credentials.get('rollback'), ''); restarted.saveData = saveData;
console.log('PASS: provider/model configuration, session-only credential, durable-save rollback');

// Start a clean compiled ChatView fixture with generic note tools.
saved = null; files.clear(); folders.clear(); folders.add('DailyNotes');
const sourcePath = 'DailyNotes/2026-10-01.md';
const source = '---\ntitle: today\n---\n# Journal\nprivate line\n## Focus\n- [ ] Alpha\n  keep nested detail\n## Other\nsource-only text\n';
files.set(sourcePath, source);
const targetDates = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
const targetOriginals = new Map(targetDates.map(date => [`DailyNotes/${date}.md`, `# Existing\nkeep ${date}\n`]));
for (const [path, text] of targetOriginals) files.set(path, text);

const chatPlugin = new AutoScheduler(app); await chatPlugin.onload();
await chatPlugin.saveProvider({ id: 'chat-fixture', name: 'Fixture', protocol: 'responses', baseUrl: 'https://example.test/v1', requiresKey: false, models: ['fixture', 'fixture-pro'] }, '', 'fixture');
mockHttp = request => modelList(request) ?? prose('unexpected');
const chatView = chatPlugin.views.get('auto-scheduler-chat')({}); await chatView.onOpen(); await chatView.modelLoad;

// Discover, read, stage and commit a copy of an arbitrary section.
let copyPhase = 0;
mockHttp = request => {
  const listed = modelList(request); if (listed) return listed;
  const body = JSON.parse(request.body); assert(body.tools.every(tool => tool.strict === false), 'Responses tools must explicitly use strict:false');
  if (copyPhase === 0) { copyPhase++; return { status: 200, json: { output: [call('discover-copy', 'discover_notes', { dates: ['2026-10-01', ...targetDates] })] } }; }
  if (copyPhase === 1) {
    const docs = toolResult(body, 'discover-copy').value.documents, sourceDoc = docs.find(doc => doc.path === sourcePath); assert(sourceDoc); copyPhase++;
    return { status: 200, json: { output: [call('read-source', 'read_note', { documentRef: sourceDoc.documentRef, mode: 'document' })] } };
  }
  if (copyPhase === 2) {
    const read = toolResult(body, 'read-source').value, focus = read.sections.find(section => section.title === 'Focus'); assert(focus);
    const calls = [call('read-focus', 'read_note', { documentRef: read.documentRef, mode: 'section', ref: focus.sectionRef })], docs = toolResult(body, 'discover-copy').value.documents;
    targetDates.forEach((date, index) => { const doc = docs.find(item => item.path === `DailyNotes/${date}.md`); calls.push(call(`read-target-${index}`, 'read_note', { documentRef: doc.documentRef, mode: 'document' })); });
    copyPhase++; return { status: 200, json: { output: calls } };
  }
  if (copyPhase === 3) {
    const content = toolResult(body, 'read-focus').value.content; assert(content.includes('## Focus') && content.includes('keep nested detail'));
    const changes = targetDates.map((date, index) => ({ operation: 'insert', targetRef: toolResult(body, `read-target-${index}`).value.documentRef, position: 'end', content }));
    copyPhase++; return { status: 200, json: { output: [call('stage-copy', 'stage_note_changes', { changes, summary: 'Copy Focus section to following seven dates' })] } };
  }
  if (copyPhase === 4) {
    const staged = toolResult(body, 'stage-copy'); assert.equal(staged.ok, true); assert.equal(staged.value.changes.length, 7); copyPhase++;
    return { status: 200, json: { output: [call('commit-copy', 'commit_changes', { changeSetRef: staged.value.changeSetRef })] } };
  }
  const committed = toolResult(body, 'commit-copy'); assert.equal(committed.ok, true); assert.equal(committed.receipt.status, 'committed'); assert.equal(committed.receipt.changedFiles.length, 7);
  throw new Error('provider offline after commit');
};
await chatView.send('复制今天的 Focus 段落到后面七天，保留源笔记和目标中的其他内容。');
assert.equal(copyPhase, 5); assert.equal(files.get(sourcePath), source, 'Copy changed the source note');
for (const [path, originalText] of targetOriginals) { const text = files.get(path); assert(text.startsWith(originalText)); assert(text.includes('## Focus')); assert(text.includes('- [ ] Alpha\n  keep nested detail')); }
const committedMessage = assistantMessages(chatView).find(message => message.receipt?.status === 'committed'); assert(committedMessage, 'Committed host receipt was not shown');
const postCommitError = assistantMessages(chatView).find(message => message.failed && message.content.includes('LLM request failed')); assert(postCommitError, 'Provider failure after commit was not shown');
assert(!postCommitError.content.toLowerCase().includes('no tasks were written')); assert(!assistantMessages(chatView).some(message => message.content.includes('本轮未修改文件')));
console.log('PASS: compiled generic discover/read/stage/commit copies an arbitrary section to seven dates, preserves source/layout, and retains receipt after provider failure');

// Exact local undo bypasses the provider and restores all targets.
const postsBeforeUndo = postCount(); mockHttp = request => { if (request.method === 'POST') throw new Error('undo must remain local'); return modelList(request); };
await chatView.send('/undo'); assert.equal(postCount(), postsBeforeUndo); assert.equal(files.get(sourcePath), source); for (const [path, text] of targetOriginals) assert.equal(files.get(path), text); assert.equal(saved.undo, null);
console.log('PASS: exact local undo restores the generic multi-note copy without provider access');

// Text-only turns write nothing and display the authoritative host status.
const filesBeforeText = JSON.stringify([...files]); mockHttp = request => modelList(request) ?? prose('只讨论，不修改。');
await chatView.send('先讨论，不要修改文件'); assert.equal(JSON.stringify([...files]), filesBeforeText); assert.equal(chatView.messages.at(-1).content, 'Host result: No files changed in this turn.'); assert(assistantMessages(chatView).some(message => message.content === '只讨论，不修改。'));
console.log('PASS: text-only model reply produces no writes and shows host no-files result');

// Unknown effort is a persistent source plus a confirmed session budget. The
// actual compiled model/tool loop must reject source loss after scheduling.
chatView.newChat();
const goalPath='DailyNotes/2026-10-12.md',calendarBefore=files.get('DailyNotes/2026-10-01.md');
let goalPhase=0,goalDocument;
mockHttp=request=>{
  const listed=modelList(request);if(listed)return listed;const body=JSON.parse(request.body);
  if(goalPhase===0){goalPhase++;return {status:200,json:{output:[call('goal-discover','discover_notes',{dates:['2026-10-12']})]}};}
  if(goalPhase===1){goalDocument=toolResult(body,'goal-discover').value.documents[0].documentRef;goalPhase++;return {status:200,json:{output:[call('goal-stage','stage_note_changes',{changes:[{operation:'insert',targetRef:goalDocument,position:'end',content:'### Research queue\n- [ ] Unknown research effort\n'}]})]}};}
  if(goalPhase===2){const staged=toolResult(body,'goal-stage');assert.equal(staged.ok,true);goalPhase++;return {status:200,json:{output:[call('goal-read','read_note',{documentRef:goalDocument,mode:'document',changeSetRef:staged.value.changeSetRef})]}};}
  if(goalPhase===3){const note=toolResult(body,'goal-read').value;goalPhase++;return {status:200,json:{output:[call('goal-plan','plan_schedule',{mode:'add',changeSetRef:note.changeSetRef,habitRefs:[],events:[],tasks:[{id:null,sourceRef:note.blocks[0].blockRef,title:'Unknown research effort',minutes:null,priority:3,split:true,minMinutes:15,dailyMinutes:30,rollingMinutes:30,estimateBasis:null,due:null,earliest:null}]})]}};}
  if(goalPhase===4){const planned=toolResult(body,'goal-plan');assert.equal(planned.ok,true,JSON.stringify(planned));assert.equal(planned.value.goals[0].totalMinutes,null);assert.equal(planned.value.goals[0].sessionBudgetMinutes,30);goalPhase++;return {status:200,json:{output:[call('goal-commit','commit_changes',{changeSetRef:planned.value.changeSetRef})]}};}
  if(goalPhase===5){const committed=toolResult(body,'goal-commit');assert.equal(committed.ok,true);goalPhase++;return {status:200,json:{output:[call('goal-current','read_note',{documentRef:goalDocument,mode:'document'})]}};}
  if(goalPhase===6){const note=toolResult(body,'goal-current').value;goalPhase++;return {status:200,json:{output:[call('goal-delete','stage_note_changes',{changes:[{operation:'delete',targetRef:note.blocks[0].blockRef}]})]}};}
  const deletion=toolResult(body,'goal-delete');assert.equal(deletion.ok,false);assert(deletion.error.includes('Pending task sources'));return prose('The source stays open. One 30 minute session was scheduled; total effort is unknown.');
};
await chatView.send('记录长期研究，在总工时未知时只安排一次30分钟工作，保留原任务。');
assert.equal(goalPhase,7);assert(files.get(goalPath).includes('- [ ] Unknown research effort'));
assert.equal(saved.aiTasks.length,1);assert.equal(saved.aiTasks[0].effort,'unknown');assert.equal(saved.aiTasks[0].completed,false);
const goalPosts=postCount();mockHttp=request=>{if(request.method==='POST')throw new Error('goal undo must remain local');return modelList(request);};
await chatView.send('/undo');assert.equal(postCount(),goalPosts);assert.equal(files.get(goalPath),'');assert.equal(files.get('DailyNotes/2026-10-01.md'),calendarBefore);assert.equal(saved.aiTasks.length,0);
console.log('PASS: compiled ChatView stages a persistent unknown-effort goal and one confirmed session atomically, rejects later source deletion, and undoes source/calendar/state');

// Runtime skill files are re-read for each send.
folders.add('Skills'); files.set('Skills/Runtime.md', '# Runtime\nUse runtime format A.'); await chatPlugin.updateAgentSettings({ skillFiles: ['Skills/Runtime.md'] });
mockHttp = request => { const listed = modelList(request); if (listed) return listed; const body = JSON.parse(request.body); assert(body.instructions.includes('Use runtime format A.')); return prose('A loaded'); };
await chatView.send('读取运行时规则 A'); files.set('Skills/Runtime.md', '# Runtime\nUse runtime format B.');
mockHttp = request => { const listed = modelList(request); if (listed) return listed; const body = JSON.parse(request.body); assert(body.instructions.includes('Use runtime format B.')); assert(!body.instructions.includes('Use runtime format A.')); return prose('B loaded'); };
await chatView.send('重新读取运行时规则');
console.log('PASS: runtime skill edits are observed by the next compiled ChatView request');

// A rejected staging call cannot create a receipt or false host success.
const beforeRejectedEdit = JSON.stringify([...files]); let rejectedPhase = 0;
mockHttp = request => {
  const listed = modelList(request); if (listed) return listed; const body = JSON.parse(request.body);
  if (rejectedPhase++ === 0) return { status: 200, json: { output: [call('bad-stage', 'stage_note_changes', { changes: [{ operation: 'insert', targetRef: 'invented', position: 'end', content: 'must not appear' }] })] } };
  const failed = toolResult(body, 'bad-stage'); assert.equal(failed.ok, false); return prose('The edit was not saved because staging failed.');
};
await chatView.send('执行一个会失败的编辑'); assert.equal(JSON.stringify([...files]), beforeRejectedEdit); assert.equal(chatView.messages.at(-1).content, 'Host result: No files changed in this turn.'); assert(!assistantMessages(chatView).some(message => message.receipt?.summary?.includes('must not appear')));
console.log('PASS: tool failure stays a real failure and cannot produce a false host success');

// Partial commit is visible, durable across restart, and locally undoable.
const originalCreate = app.vault.create, originalProcess = app.vault.process; let writesAllowed = 1;
app.vault.create = async (...args) => { if (writesAllowed-- <= 0) throw new Error('fixture write unavailable'); return originalCreate(...args); };
let partialPhase = 0; const partialDates = ['2026-10-09', '2026-10-10'];
mockHttp = request => {
  const listed = modelList(request); if (listed) return listed; const body = JSON.parse(request.body);
  if (partialPhase === 0) { partialPhase++; return { status: 200, json: { output: [call('discover-partial', 'discover_notes', { dates: partialDates })] } }; }
  if (partialPhase === 1) {
    const docs = toolResult(body, 'discover-partial').value.documents; partialPhase++;
    return { status: 200, json: { output: [call('stage-partial', 'stage_note_changes', { changes: docs.map((doc, index) => ({ operation: 'insert', targetRef: doc.documentRef, position: 'end', content: `partial ${index}` })), summary: 'Partial fixture' })] } };
  }
  if (partialPhase === 2) { const staged = toolResult(body, 'stage-partial'); partialPhase++; return { status: 200, json: { output: [call('commit-partial', 'commit_changes', { changeSetRef: staged.value.changeSetRef })] } }; }
  const committed = toolResult(body, 'commit-partial'); assert.equal(committed.ok, false); assert.equal(committed.receipt.status, 'partial'); return prose('The commit stopped after a partial write. Undo is required before another write.');
};
await chatView.send('触发部分写入夹具');
const partialReceipt = assistantMessages(chatView).find(message => message.receipt?.status === 'partial'); assert(partialReceipt && partialReceipt.failed); assert(saved.undo && saved.undo.status === 'partial');
assert.equal(files.get('DailyNotes/2026-10-09.md'), 'partial 0'); assert(!files.has('DailyNotes/2026-10-10.md')); assert(!assistantMessages(chatView).some(message => message.receipt?.status === 'committed' && message.receipt.summary === 'Partial fixture'));

app.vault.create = originalCreate; app.vault.process = originalProcess;
const partialRestart = new AutoScheduler(app); await partialRestart.onload(); mockHttp = request => modelList(request) ?? (() => { throw new Error('restart undo must remain local'); })();
const partialView = partialRestart.views.get('auto-scheduler-chat')({}); await partialView.onOpen(); await partialView.modelLoad;
const postsBeforePartialUndo = postCount(); await partialView.send('undo'); assert.equal(postCount(), postsBeforePartialUndo); assert.equal(files.get('DailyNotes/2026-10-09.md'), ''); assert.equal(saved.undo, null);
console.log('PASS: partial receipt is visible and durable, restart restores recovery, exact local undo completes without provider');

// Retry remains bounded and transparent, with no writes.
let retries = 0;
mockHttp = request => { const listed = modelList(request); if (listed) return listed; retries++; if (retries === 1) return { status: 429, headers: { 'retry-after-ms': '0' }, json: { error: { code: 'rate_limit_exceeded', message: 'requests per minute' } } }; return prose('Retry succeeded without edits.'); };
await partialView.send('测试限流重试'); assert.equal(retries, 2); assert.equal(partialView.messages.at(-1).content, 'Host result: No files changed in this turn.');
console.log('PASS: provider 429 retry completes within budget and performs no writes');

// Quota failure before any tool restores the draft and is excluded from the next request.
const receiptsBeforeQuota = partialView.messages.filter(message => message.receipt).length;
mockHttp = request => modelList(request) ?? { status: 429, json: { error: { code: 'insufficient_quota', message: 'fixture exhausted' } } };
await partialView.send('Quota-before-tool draft');
assert.equal(partialView.draftText, 'Quota-before-tool draft');
assert(partialView.messages.some(message => message.failed && message.content.includes('quota or credit balance exhausted')));
assert.equal(partialView.messages.filter(message => message.receipt).length, receiptsBeforeQuota, 'Quota failure produced a new host receipt');
mockHttp = request => {
  const listed = modelList(request); if (listed) return listed;
  const input = JSON.parse(request.body).input;
  assert(!input.some(message => message.content?.includes('Quota-before-tool draft')));
  return prose('Fresh request excluded the failed draft.');
};
await partialView.send('Fresh request after quota');
assert(partialView.messages.some(message => message.content === 'Fresh request excluded the failed draft.'));
console.log('PASS: quota failure before tools restores the draft/error and failed input is excluded from the next model context');

const commitResponder = (prefix, date, marker) => {
  let phase = 0;
  return request => {
    const listed = modelList(request); if (listed) return listed;
    const body = JSON.parse(request.body);
    if (phase === 0) { phase++; return { status: 200, json: { output: [call(`${prefix}-discover`, 'discover_notes', { dates: [date] })] } }; }
    if (phase === 1) {
      const doc = toolResult(body, `${prefix}-discover`).value.documents[0]; phase++;
      return { status: 200, json: { output: [call(`${prefix}-read`, 'read_note', { documentRef: doc.documentRef, mode: 'document' })] } };
    }
    if (phase === 2) {
      const doc = toolResult(body, `${prefix}-read`).value; phase++;
      return { status: 200, json: { output: [call(`${prefix}-stage`, 'stage_note_changes', { changes: [{ operation: 'insert', targetRef: doc.documentRef, position: 'end', content: marker }], summary: marker })] } };
    }
    if (phase === 3) {
      const staged = toolResult(body, `${prefix}-stage`); phase++;
      return { status: 200, json: { output: [call(`${prefix}-commit`, 'commit_changes', { changeSetRef: staged.value.changeSetRef })] } };
    }
    throw new Error(`${prefix} provider failed after commit`);
  };
};
const gateProcess = path => {
  const base = app.vault.process;
  let announce, release;
  const started = new Promise(resolve => { announce = resolve; });
  const allowed = new Promise(resolve => { release = resolve; });
  app.vault.process = async (file, callback) => {
    if (file.path === path) { announce(); await allowed; }
    return base(file, callback);
  };
  return { started, release, restore: () => { app.vault.process = base; } };
};

// Clear during a commit cancels model continuation but preserves the real receipt in its owning conversation.
const clearPath = 'DailyNotes/2026-10-02.md', clearBefore = files.get(clearPath), clearGate = gateProcess(clearPath);
mockHttp = commitResponder('clear-mid-commit', '2026-10-02', 'clear-mid-commit marker');
const clearOwner = partialRestart.chatHistory.activeId, clearPending = partialView.send('Commit while Clear is pressed');
await clearGate.started; partialView.clearChat(); clearGate.release(); await clearPending; clearGate.restore();
const clearConversation = partialRestart.chatHistory.sessions.find(conversation => conversation.id === clearOwner);
assert(files.get(clearPath).includes('clear-mid-commit marker'));
assert(clearConversation.messages.some(message => message.receipt?.status === 'committed' && message.receipt.summary === 'clear-mid-commit marker'));
assert(!clearConversation.messages.some(message => /draft is available|save was already in progress/i.test(message.content)));
assert.equal(clearConversation.draft, '');
const postsBeforeClearUndo = postCount(); mockHttp = request => { if (request.method === 'POST') throw new Error('clear undo must remain local'); return modelList(request); };
await partialView.send('undo'); assert.equal(postCount(), postsBeforeClearUndo); assert.equal(files.get(clearPath), clearBefore);
console.log('PASS: Clear during commit preserves truthful host receipt in the owning conversation without a duplicate resend prompt');

// Closing during commit has the same ownership guarantee after reopening the sidebar.
partialView.newChat();
const closePath = 'DailyNotes/2026-10-03.md', closeBefore = files.get(closePath), closeGate = gateProcess(closePath);
mockHttp = commitResponder('close-mid-commit', '2026-10-03', 'close-mid-commit marker');
const closeOwner = partialRestart.chatHistory.activeId, closePending = partialView.send('Commit while sidebar closes');
await closeGate.started; await partialView.onClose(); closeGate.release(); await closePending; closeGate.restore();
const closeConversation = partialRestart.chatHistory.sessions.find(conversation => conversation.id === closeOwner);
assert(files.get(closePath).includes('close-mid-commit marker'));
assert(closeConversation.messages.some(message => message.receipt?.status === 'committed' && message.receipt.summary === 'close-mid-commit marker'));
assert(!closeConversation.messages.some(message => /draft is available|save was already in progress/i.test(message.content)));
assert.equal(closeConversation.draft, '');
mockHttp = request => modelList(request) ?? prose('unused');
const continuedView = partialRestart.views.get('auto-scheduler-chat')({}); await continuedView.onOpen(); await continuedView.modelLoad;
assert(continuedView.messages.some(message => message.receipt?.summary === 'close-mid-commit marker'));
const postsBeforeCloseUndo = postCount(); await continuedView.send('/undo'); assert.equal(postCount(), postsBeforeCloseUndo); assert.equal(files.get(closePath), closeBefore);
console.log('PASS: onClose during commit retains actual host result for the original conversation and avoids duplicate resend state');

// Cancellation prevents a late tool call from crossing into a cleared conversation.
let resolveLate;
mockHttp = request => { const listed = modelList(request); if (listed) return listed; return new Promise(resolve => { resolveLate = resolve; }); };
const beforeCancel = JSON.stringify([...files]), pending = continuedView.send('稍后取消');
for (let index = 0; index < 30 && !resolveLate; index++) await Promise.resolve(); assert(resolveLate); continuedView.clearChat(); await pending;
resolveLate({ status: 200, json: { output: [call('late-write', 'stage_note_changes', { changes: [{ operation: 'insert', targetRef: 'late', position: 'end', content: 'late' }] })] } }); await Promise.resolve();
assert.equal(JSON.stringify([...files]), beforeCancel); assert.equal(continuedView.messages.length, 0);
console.log('PASS: cancellation suppresses late provider tool calls and leaves files unchanged');

// Conversations keep independent histories and drafts across sidebar close/reopen.
mockHttp = request => modelList(request) ?? prose('Alpha response'); await continuedView.send('Alpha context'); const alphaId = partialRestart.chatHistory.activeId;
continuedView.newChat();
mockHttp = request => { const listed = modelList(request); if (listed) return listed; const input = JSON.parse(request.body).input; assert(!input.some(message => message.content?.includes('Alpha context'))); return prose('Beta response'); };
await continuedView.send('Beta context'); const betaId = partialRestart.chatHistory.activeId; assert.notEqual(alphaId, betaId);
continuedView.switchConversation(alphaId); assert(continuedView.messages.some(message => message.content === 'Alpha context'));
const composer = continuedView.contentEl.all().find(node => node.options.attr?.['aria-label'] === 'Task conversation'); composer.value = 'Alpha draft'; composer.events.input(); await continuedView.onClose();
mockHttp = request => modelList(request) ?? prose('unused'); const reopened = partialRestart.views.get('auto-scheduler-chat')({}); await reopened.onOpen(); await reopened.modelLoad;
assert.equal(reopened.draftText, 'Alpha draft'); assert(reopened.messages.some(message => message.content === 'Alpha response')); reopened.switchConversation(betaId); assert(reopened.messages.some(message => message.content === 'Beta response'));
assert(!JSON.stringify(saved).includes('Alpha context')); assert(!JSON.stringify(saved).includes('Beta context'));
console.log('PASS: conversation histories and drafts remain isolated in memory across sidebar close/reopen');

assert(creates > 0 && processes > 0); assert(!JSON.stringify(saved).includes('session-token'));
console.log('Smoke test complete: no real vault, provider, API key, or personal note was accessed.');
