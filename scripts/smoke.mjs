// Host API simulation only. Never reads or writes a real Obsidian vault.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
process.env.TZ = 'Asia/Shanghai';
const notices = []; let saved = null; let latestModal;
let mockResponse; const requests = []; const openedNotes = [];
class Node {
  constructor(tag = '', options = {}) { this.tag = tag; this.options = options; this.children = []; this.events = {}; }
  createEl(tag, options) { const node = new Node(tag, options); this.children.push(node); return node; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addEventListener(name, callback) { this.events[name] = callback; }
  addClass() {}
  empty() { this.children = []; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
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
const fixedDate = '2026-10-01T08:00:00+08:00';
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedDate])); }
  static now() { return new Date(fixedDate).getTime(); }
}
const clipboardCopies = [];
const module = { exports: {} };
vm.runInNewContext(await readFile('main.js', 'utf8'), {
  navigator: { clipboard: { writeText: async text => { clipboardCopies.push(text); } } },
  module, exports: module.exports, Date: Clock, Intl, console, structuredClone, crypto: webcrypto, URL, setTimeout, clearTimeout,
  require: name => {
    assert.equal(name, 'obsidian', 'Unexpected runtime dependency');
    return { Plugin, Modal, ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = new Node(); } }, TFile, TFolder, PluginSettingTab: class {}, Setting: class {},
      requestUrl: async request => { requests.push(request); return { status: 200, json: mockResponse }; },
      Notice: class { constructor(text) { notices.push(text); } }, normalizePath: path => path };
  },
});
const AutoScheduler = module.exports.default;
assert.equal(typeof AutoScheduler, 'function');
const original = '- [ ] 宿主演示 <!-- as id=host remaining=60 priority=3 -->';
const files = new Map([['Tasks/Host.md', original]]);
const folders = new Set(['Tasks']); let creates = 0, processes = 0;
const app = { workspace: { getLeavesOfType: () => [], openLinkText: async () => {}, getLeaf: () => ({ openFile: async file => { openedNotes.push(file.path); } }) }, vault: {
  getAbstractFileByPath: path => files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
  getMarkdownFiles: () => [...files.keys()].map(path => new TFile(path)),
  read: async file => files.get(file.path),
  createFolder: async path => { folders.add(path); },
  create: async (path, text) => { assert(!files.has(path)); files.set(path, text); creates++; },
  process: async (file, callback) => { const text = callback(files.get(file.path)); files.set(file.path, text); processes++; return text; },
} };
const plugin = new AutoScheduler(app); await plugin.onload();
assert.equal(plugin.commands.length, 5);
plugin.commands.find(command => command.id === 'preview-week').callback();
await plugin.operations.tail;
assert(latestModal, 'Preview modal failed to open'); assert.equal(creates, 0);
const apply = latestModal.contentEl.all().find(node => node.options.text === 'Apply schedule');
assert(apply); assert.equal(apply.disabled, false); apply.events.click(); await plugin.operations.tail;
assert.equal(creates, 1); assert(files.get('Scheduler/Schedule.md').includes('task=host'));
assert(saved.undo); assert.equal(files.get('Tasks/Host.md'), original);
// Simulate restarting the plugin and restoring durable undo data.
const restarted = new AutoScheduler(app); await restarted.onload();
restarted.commands.find(command => command.id === 'undo-last').callback(); await restarted.operations.tail;
assert.equal(processes, 1); assert.equal(saved.undo, null);
assert(!files.get('Scheduler/Schedule.md').includes('as-block')); assert.equal(files.get('Tasks/Host.md'), original);
assert(notices.some(text => text.includes('Schedule saved'))); assert(notices.some(text => text.includes('Last schedule undone')));
// A custom output may equal the DEFAULT fixed path when fixedFile is changed.
// Undo path validation must be independent of today's/default settings.
await restarted.updateSettings({ fixedFile: 'Scheduler/Meetings.md', outputFile: 'Scheduler/Fixed.md' });
restarted.commands.find(command => command.id === 'preview-week').callback(); await restarted.operations.tail;
const customApply = latestModal.contentEl.all().find(node => node.options.text === 'Apply schedule');
customApply.events.click(); await restarted.operations.tail; assert(saved.undo);
const customRestart = new AutoScheduler(app); await customRestart.onload();
assert(customRestart.state.undo, 'Custom path undo was discarded at restart');
customRestart.commands.find(command => command.id === 'undo-last').callback(); await customRestart.operations.tail;
assert.equal(saved.undo, null); assert(!files.get('Scheduler/Fixed.md').includes('as-block'));
assert.equal(files.get('Tasks/Host.md'), original);
// Daily batch survives restart and restores all files through public Vault methods.
files.set('Tasks/Host.md', original.replace('remaining=60', 'remaining=360'));
files.set('DailyNotes/2026-10-01.md', '# Day planner\n- [ ] 09:00 - 10:00 会议\n# 日记\n保留');
const dailyOriginal = files.get('DailyNotes/2026-10-01.md');
await customRestart.updateSettings({ outputLocation: 'daily', outputMode: 'gantt', weekdays: [0,1,2,3,4,5,6], periods: ['09:00-12:00'], dailyCapacity: 180, fixedBuffer: 0, blockBuffer: 0 });
customRestart.commands.find(command => command.id === 'preview-week').callback(); await customRestart.operations.tail;
const dailyApply = latestModal.contentEl.all().find(node => node.options.text === 'Apply schedule');
assert.equal(dailyApply.disabled, false); dailyApply.events.click(); await customRestart.operations.tail;
assert(saved.undo.entries.length >= 2); assert(files.get('DailyNotes/2026-10-01.md').includes('10:00 -')); assert(!files.get('DailyNotes/2026-10-01.md').includes('[start::')); assert(saved.tracking);
const dailyRestart = new AutoScheduler(app); await dailyRestart.onload(); assert(dailyRestart.state.undo);
dailyRestart.commands.find(command => command.id === 'undo-last').callback(); await dailyRestart.operations.tail;
assert.equal(saved.undo, null); assert.equal(files.get('DailyNotes/2026-10-01.md'), dailyOriginal);
assert(!files.get('DailyNotes/2026-10-02.md').includes('as-block'));
console.log('PASS: CJS load, command registration, read-only preview, Vault create/process, durable restart undo, unchanged source, daily multi-file apply/restart/undo');
// Exercise the new AI entry through the real bundle without a network request.
const aiDraft = { title: '课程复习', minutes: 120, priority: 4, split: true, minMinutes: 30, due: null, earliest: null };
const previousModal = latestModal;
const aiResult = await dailyRestart.scheduleAi([aiDraft]);
assert.equal(latestModal, previousModal, 'AI scheduling must not open a modal');
assert(aiResult.text.includes('课程复习')); assert(aiResult.notes.length > 0);
assert.equal(saved.aiTasks.length, 1); assert(!JSON.stringify(saved).includes('apiToken'));
assert([...files.values()].some(text => text.includes('课程复习')));
const aiRestart = new AutoScheduler(app); await aiRestart.onload(); assert.equal(aiRestart.state.aiTasks.length, 1);
aiRestart.commands.find(command => command.id === 'undo-last').callback(); await aiRestart.operations.tail;
assert.equal(saved.aiTasks.length, 0); assert(![...files.values()].some(text => text.includes('课程复习')));
console.log('PASS: real bundle AI direct apply without modal, persistent task restart/undo, no durable API token');

// Migrate 0.2.0 data with AI sources before the first durable BYOK save.
await aiRestart.scheduleAi([aiDraft]);
delete saved.byok;
const migrated = new AutoScheduler(app); await migrated.onload();
assert.equal(migrated.state.aiTasks.length, 1); assert.equal(saved.aiTasks.length, 1); assert(saved.byok);
// Configure local providers with session credentials and retain model identity by provider.
await migrated.saveProvider({ id: 'local-test', name: 'Local', protocol: 'chat-completions', baseUrl: 'http://localhost:1234/v1', requiresKey: false, models: ['local-test-model', 'local-fast'] }, 'fixture-token', 'local-fast');
assert.equal(migrated.state.llm.model, 'local-fast'); assert(!JSON.stringify(saved).includes('fixture-token'));
await assert.rejects(migrated.saveProvider({ id: 'local-test', name: 'Local', protocol: 'chat-completions', baseUrl: 'http://localhost:1234/v1', requiresKey: false, models: ['local-test-model', 'local-fast'] }, 'fixture-token', 'unknown-model'), /Select a model/);
assert.equal(migrated.state.llm.model, 'local-fast');
assert.equal(await migrated.getApiToken(), 'fixture-token');
await migrated.selectModel('legacy', saved.byok.providers.find(p => p.id === 'legacy').models[0]);
assert.equal(await migrated.getApiToken(), '');
await migrated.removeProvider('local-test'); assert(!saved.byok.providers.some(p => p.id === 'local-test'));
await migrated.selectModel('legacy', migrated.byok.providers[0].models[0]);
migrated.commands.find(command => command.id === 'undo-last').callback(); await migrated.operations.tail; assert.equal(saved.aiTasks.length, 0);
console.log('PASS: BYOK legacy migration preserves AI tasks/undo, provider/model routing, session credential isolation, removal, no serialized tokens');

const beforeFailedSave = JSON.stringify(migrated.state); const originalSaveData = migrated.saveData.bind(migrated);
migrated.saveData = async () => { throw new Error('disk unavailable'); };
await assert.rejects(migrated.saveProvider({ id: 'rollback-test', name: 'Rollback', protocol: 'chat-completions', baseUrl: 'https://example.test/v1', requiresKey: true, models: ['model'] }, 'fixture-new-token'), /previous key was restored/);
assert.equal(JSON.stringify(migrated.state), beforeFailedSave); assert.equal(await migrated.credentials.get('rollback-test'), '');
migrated.saveData = originalSaveData;
console.log('PASS: provider save failure restores prior credential and leaves model configuration unchanged');

// Exercise the actual chat UI with a fake provider transport: no network or real vault.
saved = null; files.clear(); folders.clear(); folders.add('Tasks');
const chatPlugin = new AutoScheduler(app); await chatPlugin.onload();
await chatPlugin.saveProvider({ id: 'chat-fixture', name: 'Fixture', protocol: 'responses', baseUrl: 'https://example.test/v1', requiresKey: false, models: ['fixture', 'fixture-pro'] }, '');
await chatPlugin.updateSettings({ weekdays: [0,1,2,3,4,5,6], periods: ['09:00-12:00'], dailyCapacity: 60, fixedBuffer: 0, blockBuffer: 0 });
const chatView = chatPlugin.views.get('auto-scheduler-chat')({}); await chatView.onOpen();
const header = chatView.contentEl.children.find(node => node.options.cls === 'auto-scheduler-chat-header');
assert.equal(header.children[0].options.text, 'Configure provider / API key');
const modelSelect = header.all().find(node => node.tag === 'select' && node.options.attr?.['aria-label'] === 'Chat model');
assert(modelSelect); assert(modelSelect.children.some(node => node.options.text === 'Fixture / fixture-pro'));
modelSelect.value = JSON.stringify(['chat-fixture', 'fixture-pro']); modelSelect.events.change(); await chatPlugin.operations.tail;
assert.equal(chatPlugin.state.llm.model, 'fixture-pro');
const draft = { ...aiDraft, minutes: 600 };
mockResponse = { output: [
  { type: 'message', content: [{ type: 'output_text', text: '模型猜测：明天20点完成。' }] },
  { type: 'function_call', name: 'create_tasks', arguments: JSON.stringify({ tasks: [draft] }) },
] };
const modalBeforeChat = latestModal;
await chatView.send('帮我安排课程复习，预计10小时');
assert.equal(JSON.parse(requests.at(-1).body).model, 'fixture-pro');
assert.equal(latestModal, modalBeforeChat); assert.equal(chatView.busy, false);
const answer = chatView.messages.at(-1);
assert(answer.content.includes('2026-10-01 09:00–10:00: 课程复习'));
assert(answer.content.includes('remaining 180 min')); assert(!answer.content.includes('20点'));
assert.equal(answer.notes.length, 7); assert.equal(openedNotes.at(-1), 'DailyNotes/2026-10-01.md');
assert([...files.values()].every(text => !text.includes('as-block') && !text.includes('scheduled::')));
const dateLink = chatView.contentEl.all().find(node => node.tag === 'a' && node.options.text === 'Open 2026-10-02');
dateLink.events.click({ preventDefault() {} }); await Promise.resolve();
assert.equal(openedNotes.at(-1), 'DailyNotes/2026-10-02.md');
mockResponse = { output: [{ type: 'message', content: [{ type: 'output_text', text: '有什么需要调整的？' }] }] };
const filesBeforeConversation = JSON.stringify([...files]);
await chatView.send('先讨论一下');
assert.equal(chatView.messages.at(-1).content, '有什么需要调整的？'); assert.equal(JSON.stringify([...files]), filesBeforeConversation);
assert(JSON.parse(requests.at(-1).body).input.every(message => Object.keys(message).sort().join(',') === 'content,role'), 'Local note links leaked to provider');
// A navigation failure must keep the committed success report and durable undo.
const openLeaf = app.workspace.getLeaf;
app.workspace.getLeaf = () => ({ openFile: async () => { throw new Error('navigation failed'); } });
await chatPlugin.updateSettings({ dailyCapacity: 180 });
mockResponse = { output: [{ type: 'function_call', name: 'create_tasks', arguments: JSON.stringify({ tasks: [aiDraft] }) }] };
await chatView.send('再安排一门课程，两小时');
assert(chatView.messages.at(-1).content.includes('Schedule saved, but the daily note could not be opened'));
assert(chatView.messages.at(-2).content.includes('Saved to daily notes')); assert.equal(saved.aiTasks.length, 2);
app.workspace.getLeaf = openLeaf;
chatPlugin.commands.find(command => command.id === 'undo-last').callback(); await chatPlugin.operations.tail;
assert.equal(saved.aiTasks.length, 1);
// No-capacity and malformed source errors leave both files and settings unchanged.
await chatPlugin.updateSettings({ dailyCapacity: 15 });
const noCapacityState = JSON.stringify(saved), noCapacityFiles = JSON.stringify([...files]);
await chatView.send('帮我安排另一个任务');
assert(chatView.messages.at(-1).content.includes('No new tasks were created'));
assert.equal(JSON.stringify(saved), noCapacityState); assert.equal(JSON.stringify([...files]), noCapacityFiles);
await chatPlugin.updateSettings({ dailyCapacity: 180 });
files.set('Tasks/Invalid.md', '- [ ] 错误 <!-- as id=invalid remaining=5 -->');
const invalidState = JSON.stringify(saved);
await chatView.send('安排新任务');
assert(chatView.messages.at(-1).content.includes('Request failed')); assert.equal(JSON.stringify(saved), invalidState);
files.delete('Tasks/Invalid.md');
// A batch failure after the first write must report partial state, retain backup, and undo.
const createFile = app.vault.create, processFile = app.vault.process;
let writesBeforeFailure = 1;
app.vault.create = async (...args) => { if (writesBeforeFailure-- <= 0) throw new Error('write unavailable'); return createFile(...args); };
app.vault.process = async (...args) => { if (writesBeforeFailure-- <= 0) throw new Error('write unavailable'); return processFile(...args); };
const partialFilesBefore = new Map(files);
await chatView.send('安排新任务');
assert(chatView.messages.at(-1).content.includes('some daily notes may have been written')); assert(saved.undo);
app.vault.create = createFile; app.vault.process = processFile;
chatPlugin.commands.find(command => command.id === 'undo-last').callback(); await chatPlugin.operations.tail;
assert.equal(saved.aiTasks.length, 1);
for (const [path, value] of partialFilesBefore) assert.equal(files.get(path), value);
console.log('PASS: chat direct scheduling, exact cross-day times/links, partial capacity, no invented model times, no link metadata sent, navigation failure, invalid inputs, partial write recovery');
// The actual bundle must load templates even without normal tasks or a provider.
saved = null; files.clear();
const habitPlugin = new AutoScheduler(app); await habitPlugin.onload();
habitPlugin.commands.find(c => c.id === 'create-habit-template').callback(); await habitPlugin.operations.tail;
assert(!files.get('Habits/Template.md').includes('<!--'));
assert(files.get('Habits/Template.md').includes('```markdown'));
assert.equal(openedNotes.at(-1), 'Habits/Template.md');
files.set('Habits/Template.md', '- 19:00-19:30 ⏫ 晚间习惯（每天）');
habitPlugin.commands.find(c => c.id === 'create-habit-template').callback(); await habitPlugin.operations.tail;
assert(files.get('Habits/Template.md').includes('晚间习惯'));
habitPlugin.state.settings = { ...habitPlugin.state.settings, outputLocation: 'daily', outputMode: 'day-planner', cleanDaily: true };
habitPlugin.commands.find(c => c.id === 'preview-week').callback(); await habitPlugin.operations.tail;
assert.equal(latestModal.preview.result.errors.length, 0);
assert.equal(latestModal.preview.result.blocks.length, 7);
console.log('PASS: habit template command opens note, never overwrites, and generates seven fixed occurrences without tasks or LLM');
const applyHabits = latestModal.contentEl.all().find(node => node.options.text === 'Apply schedule');
applyHabits.events.click(); await habitPlugin.operations.tail;
assert(files.get('DailyNotes/2026-10-01.md').includes('19:00 - 19:30 ⏫ 晚间习惯'));
assert(!files.get('DailyNotes/2026-10-01.md').includes('as-block'));
const habitRestart = new AutoScheduler(app); await habitRestart.onload();
habitRestart.commands.find(c => c.id === 'preview-week').callback(); await habitRestart.operations.tail;
assert.equal(latestModal.preview.diff.added.length, 0);
assert.equal(latestModal.preview.diff.removed.length, 0);
habitRestart.commands.find(c => c.id === 'undo-last').callback(); await habitRestart.operations.tail;
assert.equal(files.get('DailyNotes/2026-10-01.md'), '# Day planner\n');
assert(files.get('Habits/Template.md').includes('晚间习惯'));
console.log('PASS: actual bundle clean habit output, restart deduplication, and undo without changing template');
// Full chat -> skill/tool -> host -> template and schedule, without a real LLM.
saved = null; files.clear(); folders.clear();
const habitChat = new AutoScheduler(app); await habitChat.onload();
await habitChat.saveProvider({ id: 'habit-fixture', name: 'Fixture', protocol: 'responses', baseUrl: 'https://example.test/v1', requiresKey: false, models: ['fixture'] }, '');
await habitChat.updateSettings({ habitFolder: 'Templates/Habits', fixedBuffer: 0, blockBuffer: 0 });
const habitView = habitChat.views.get('auto-scheduler-chat')({}); await habitView.onOpen();
const habitDraft = { title: '饭后慢走', start: '19:00', end: '19:30', days: [0,1,2,3,4,5,6], priority: 3 };
mockResponse = { output: [{ type: 'function_call', name: 'create_habits', arguments: JSON.stringify({ habits: [habitDraft] }) }] };
const oldModal = latestModal;
await habitView.send('每天19点饭后慢走半小时');
assert.equal(latestModal, oldModal); assert.equal(saved.aiTasks.length, 0);
assert(files.get('Templates/Habits/AI-Habits.md').includes('19:00-19:30 🔼 饭后慢走 (Sun, Mon, Tue, Wed, Thu, Fri, Sat)'));
assert(habitView.messages.at(-1).content.includes('2026-10-01 19:00–19:30: 饭后慢走'));
assert.equal(openedNotes.at(-1), 'DailyNotes/2026-10-01.md');
assert(JSON.parse(requests.at(-1).body).instructions.includes('Templates/Habits/AI-Habits.md'));
const copyButton = habitView.contentEl.all().find(n => n.options.attr?.['aria-label'] === 'Copy message');
copyButton.events.click(); await Promise.resolve(); assert.equal(clipboardCopies.at(-1), '每天19点饭后慢走半小时');
const css = await readFile('styles.css', 'utf8'); assert(css.includes('-webkit-user-select: text')); assert(css.includes('user-select: text'));
const habitSaved = new AutoScheduler(app); await habitSaved.onload();
habitSaved.commands.find(c => c.id === 'undo-last').callback(); await habitSaved.operations.tail;
assert.equal(files.get('Templates/Habits/AI-Habits.md'), ''); assert.equal(files.get('DailyNotes/2026-10-01.md'), '# Day planner\n');
console.log('PASS: actual chat habit tool uses configured path, writes recurring template and dates, copies messages, and undo restores both after restart');
