// Host API simulation only. Never reads or writes a real Obsidian vault.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
process.env.TZ = 'Asia/Shanghai';
const notices = []; let saved = null; let latestModal;
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
  constructor(app) { this.app = app; this.commands = []; }
  async loadData() { return saved; }
  async saveData(value) { saved = structuredClone(value); }
  registerView() {}
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
const module = { exports: {} };
vm.runInNewContext(await readFile('main.js', 'utf8'), {
  module, exports: module.exports, Date: Clock, Intl, console, structuredClone, crypto: webcrypto, URL, setTimeout, clearTimeout,
  require: name => {
    assert.equal(name, 'obsidian', 'Unexpected runtime dependency');
    return { Plugin, Modal, ItemView: class {}, TFile, TFolder, PluginSettingTab: class {}, Setting: class {},
      Notice: class { constructor(text) { notices.push(text); } }, normalizePath: path => path };
  },
});
const AutoScheduler = module.exports.default;
assert.equal(typeof AutoScheduler, 'function');
const original = '- [ ] 宿主演示 <!-- as id=host remaining=60 priority=3 -->';
const files = new Map([['Tasks/Host.md', original]]);
const folders = new Set(['Tasks']); let creates = 0, processes = 0;
const app = { workspace: { getLeavesOfType: () => [], openLinkText: async () => {} }, vault: {
  getAbstractFileByPath: path => files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
  getMarkdownFiles: () => [...files.keys()].map(path => new TFile(path)),
  read: async file => files.get(file.path),
  createFolder: async path => { folders.add(path); },
  create: async (path, text) => { assert(!files.has(path)); files.set(path, text); creates++; },
  process: async (file, callback) => { const text = callback(files.get(file.path)); files.set(file.path, text); processes++; return text; },
} };
const plugin = new AutoScheduler(app); await plugin.onload();
assert.equal(plugin.commands.length, 4);
plugin.commands.find(command => command.id === 'preview-week').callback();
await plugin.operations.tail;
assert(latestModal, 'Preview modal failed to open'); assert.equal(creates, 0);
const apply = latestModal.contentEl.all().find(node => node.options.text === '应用排程');
assert(apply); assert.equal(apply.disabled, false); apply.events.click(); await plugin.operations.tail;
assert.equal(creates, 1); assert(files.get('Scheduler/Schedule.md').includes('task=host'));
assert(saved.undo); assert.equal(files.get('Tasks/Host.md'), original);
// Simulate restarting the plugin and restoring durable undo data.
const restarted = new AutoScheduler(app); await restarted.onload();
restarted.commands.find(command => command.id === 'undo-last').callback(); await restarted.operations.tail;
assert.equal(processes, 1); assert.equal(saved.undo, null);
assert(!files.get('Scheduler/Schedule.md').includes('as-block')); assert.equal(files.get('Tasks/Host.md'), original);
assert(notices.some(text => text.includes('已写入'))); assert(notices.some(text => text.includes('已撤销')));
// A custom output may equal the DEFAULT fixed path when fixedFile is changed.
// Undo path validation must be independent of today's/default settings.
await restarted.updateSettings({ fixedFile: 'Scheduler/Meetings.md', outputFile: 'Scheduler/Fixed.md' });
restarted.commands.find(command => command.id === 'preview-week').callback(); await restarted.operations.tail;
const customApply = latestModal.contentEl.all().find(node => node.options.text === '应用排程');
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
const dailyApply = latestModal.contentEl.all().find(node => node.options.text === '应用排程');
assert.equal(dailyApply.disabled, false); dailyApply.events.click(); await customRestart.operations.tail;
assert(saved.undo.entries.length >= 2); assert(files.get('DailyNotes/2026-10-01.md').includes('10:00 -')); assert(!files.get('DailyNotes/2026-10-01.md').includes('[start::')); assert(saved.tracking);
const dailyRestart = new AutoScheduler(app); await dailyRestart.onload(); assert(dailyRestart.state.undo);
dailyRestart.commands.find(command => command.id === 'undo-last').callback(); await dailyRestart.operations.tail;
assert.equal(saved.undo, null); assert.equal(files.get('DailyNotes/2026-10-01.md'), dailyOriginal);
assert(!files.get('DailyNotes/2026-10-02.md').includes('as-block'));
console.log('PASS: CJS load, command registration, read-only preview, Vault create/process, durable restart undo, unchanged source, daily multi-file apply/restart/undo');
// Exercise the new AI entry through the real bundle without a network request.
const aiDraft = { title: '课程复习', minutes: 120, priority: 4, split: true, minMinutes: 30, due: null, earliest: null };
let aiApplied = false;
await dailyRestart.previewAi([aiDraft], () => { aiApplied = true; });
const aiApply = latestModal.contentEl.all().find(node => node.options.text === '应用排程');
assert.equal(aiApply.disabled, false); assert.equal(saved.aiTasks.length, 0);
aiApply.events.click(); await dailyRestart.operations.tail;
assert(aiApplied); assert.equal(saved.aiTasks.length, 1); assert(!JSON.stringify(saved).includes('apiToken'));
assert([...files.values()].some(text => text.includes('课程复习')));
const aiRestart = new AutoScheduler(app); await aiRestart.onload(); assert.equal(aiRestart.state.aiTasks.length, 1);
aiRestart.commands.find(command => command.id === 'undo-last').callback(); await aiRestart.operations.tail;
assert.equal(saved.aiTasks.length, 0); assert(![...files.values()].some(text => text.includes('课程复习')));
console.log('PASS: real bundle AI preview/apply, persistent task restart/undo, no durable API token');

// Migrate 0.2.0 data with AI sources before the first durable BYOK save.
await aiRestart.previewAi([aiDraft], () => {});
latestModal.contentEl.all().find(node => node.options.text === '应用排程').events.click(); await aiRestart.operations.tail;
delete saved.byok;
const migrated = new AutoScheduler(app); await migrated.onload();
assert.equal(migrated.state.aiTasks.length, 1); assert.equal(saved.aiTasks.length, 1); assert(saved.byok);
// Configure local providers with session credentials and retain model identity by provider.
await migrated.saveProvider({ id: 'local-test', name: 'Local', protocol: 'chat-completions', baseUrl: 'http://localhost:1234/v1', requiresKey: false, models: ['local-test-model'] }, 'fixture-token');
assert.equal(migrated.state.llm.model, 'local-test-model'); assert(!JSON.stringify(saved).includes('fixture-token'));
assert.equal(await migrated.getApiToken(), 'fixture-token');
await migrated.selectModel('legacy', saved.byok.providers.find(p => p.id === 'legacy').models[0]);
assert.equal(await migrated.getApiToken(), '');
await migrated.removeProvider('local-test'); assert(!saved.byok.providers.some(p => p.id === 'local-test'));
await migrated.selectModel('legacy', migrated.byok.providers[0].models[0]);
migrated.commands.find(command => command.id === 'undo-last').callback(); await migrated.operations.tail; assert.equal(saved.aiTasks.length, 0);
console.log('PASS: BYOK legacy migration preserves AI tasks/undo, provider/model routing, session credential isolation, removal, no serialized tokens');

const beforeFailedSave = JSON.stringify(migrated.state); const originalSaveData = migrated.saveData.bind(migrated);
migrated.saveData = async () => { throw new Error('disk unavailable'); };
await assert.rejects(migrated.saveProvider({ id: 'rollback-test', name: 'Rollback', protocol: 'chat-completions', baseUrl: 'https://example.test/v1', requiresKey: true, models: ['model'] }, 'fixture-new-token'), /已恢复原令牌/);
assert.equal(JSON.stringify(migrated.state), beforeFailedSave); assert.equal(await migrated.credentials.get('rollback-test'), '');
migrated.saveData = originalSaveData;
console.log('PASS: provider save failure restores prior credential and leaves model configuration unchanged');
