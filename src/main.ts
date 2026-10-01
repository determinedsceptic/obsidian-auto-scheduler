import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import { applyPreview, createPreview, timezone, undoLast } from './transaction';
import type { Preview, VaultPort, StatePort } from './transaction';
import { DEFAULT_SETTINGS } from './types';
import type { PluginState, Settings, UndoRecord } from './types';
import { clock, safeVaultPath } from './time';
import { OperationQueue } from './queue';
import { endClock } from './output';

class ObsidianVault implements VaultPort {
  constructor(private app: App) {}
  async listTasks(folder: string, excluded: string[]): Promise<string[]> {
    const path = normalizePath(folder);
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw new Error(`任务目录不存在：${path}。请先设置任务目录`);
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(`${path}/`) && !excluded.includes(f.path)).map(f => f.path).sort();
  }
  async read(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`路径不是文件：${path}`);
    return this.app.vault.read(file);
  }
  async writeChecked(path: string, expected: string | null, next: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (expected !== null) {
      if (!(file instanceof TFile)) throw new Error('输出文件被删除或类型发生变化，请重新预览');
      await this.app.vault.process(file, current => {
        if (current !== expected) throw new Error('输出在写入前发生变化，拒绝覆盖');
        return next;
      });
    } else {
      if (file) throw new Error('输出文件已由其他操作创建，请重新预览');
      const parts = path.split('/').slice(0, -1); let parent = '';
      for (const part of parts) {
        parent = parent ? `${parent}/${part}` : part;
        const entry = this.app.vault.getAbstractFileByPath(parent);
        if (!entry) await this.app.vault.createFolder(parent);
        else if (!(entry instanceof TFolder)) throw new Error(`输出父路径不是目录：${parent}`);
      }
      // create refuses an existing file; do not fall back to modify.
      await this.app.vault.create(path, next);
    }
  }
}
function validUndo(value: unknown): value is UndoRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as UndoRecord;
  return safeVaultPath(record.path) && record.path.endsWith('.md')
    && (record.before === null || typeof record.before === 'string') && typeof record.after === 'string'
    && typeof record.createdAt === 'string';
}
export default class AutoScheduler extends Plugin {
  state: PluginState = { settings: { ...DEFAULT_SETTINGS }, undo: null };
  private operations = new OperationQueue();
  private vaultPort!: VaultPort;
  private storage: StatePort = {
    saveUndo: async record => {
      const next = { settings: this.state.settings, undo: record };
      await this.saveData(next); this.state = next;
    },
  };
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<PluginState> | null;
    this.state.settings = { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) };
    if (saved?.undo && validUndo(saved.undo)) this.state.undo = saved.undo;
    else if (saved?.undo) new Notice('Auto Scheduler：撤销记录格式异常，未启用自动恢复。请保留插件 data.json 备份。');
    this.vaultPort = new ObsidianVault(this.app);
    this.addSettingTab(new SchedulerSettings(this.app, this));
    this.addCommand({ id: 'preview-week', name: '预览一周排程', callback: () => { void this.action(async () => {
      const preview = await createPreview(this.vaultPort, this.state.settings);
      new PreviewModal(this.app, preview, this).open();
    }); } });
    this.addCommand({ id: 'undo-last', name: '撤销最近一次排程', callback: () => { void this.action(async () => {
      await undoLast(this.vaultPort, this.storage, this.state.undo); new Notice('已撤销最近一次排程');
    }); } });
    this.addRibbonIcon('calendar-clock', '预览一周排程', () => { void this.action(async () => {
      new PreviewModal(this.app, await createPreview(this.vaultPort, this.state.settings), this).open();
    }); });
  }
  async action(work: () => Promise<void>): Promise<void> {
    // Serialize all writes, including rapid settings edits. Never discard keystrokes.
    await this.operations.run(work).catch(error => {
      new Notice(`Auto Scheduler：${(error as Error).message}`, 12000);
    });
  }
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    await this.action(async () => {
      const next = { settings: { ...this.state.settings, ...patch }, undo: this.state.undo };
      // Keep incomplete form values so users can edit several fields; preview validates them.
      await this.saveData(next); this.state = next;
    });
  }
  async apply(preview: Preview, done: () => void): Promise<void> {
    await this.action(async () => {
      const result = await applyPreview(this.vaultPort, this.storage, preview, this.state.settings);
      new Notice(result.warning ?? (result.changed ? '排程已写入；可通过命令撤销' : '排程无变化，无需写入'), result.warning ? 12000 : 5000);
      done();
    });
  }
}
class PreviewModal extends Modal {
  constructor(app: App, private preview: Preview, private plugin: AutoScheduler) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('auto-scheduler-modal');
    const { contentEl } = this; const { result, settings, diff } = this.preview;
    contentEl.createEl('h2', { text: '一周排程预览' });
    contentEl.createEl('p', { text: `${this.preview.today} 起一周 · ${this.preview.timezone} · 输出：${settings.outputFile}` });
    contentEl.createEl('p', { text: '未锁定的本周工作块会被替换。保留手动移动的工作块，请先在输出注释中设 locked=true。勾选工作块不更新源任务。' });
    if (this.preview.snapshot[settings.fixedFile] === null) contentEl.createEl('p', { text: `固定日程文件不存在：${settings.fixedFile}。本次按无固定日程处理，请确认空闲时段。`, cls: 'auto-scheduler-warning' });
    if (result.errors.length) {
      contentEl.createEl('h3', { text: '需要修正的输入' }); const list = contentEl.createEl('ul');
      for (const error of result.errors) list.createEl('li', { text: `${error.path}${error.line ? `:${error.line}` : ''}：${error.message}` });
    }
    contentEl.createEl('p', { text: `新增 ${diff.added.length} · 移除 ${diff.removed.length} · 保留 ${diff.retained.length}` });
    if (diff.removed.length) {
      const detail = contentEl.createEl('details'); detail.createEl('summary', { text: '将移除的工作块' });
      for (const b of diff.removed) detail.createEl('p', { text: `${b.date} ${clock(b.start)}–${endClock(b)} · ${b.taskId}` });
    }
    for (const day of result.days) {
      contentEl.createEl('h3', { text: `${day.date} · 占用 ${day.occupied}/${day.capacity} 分钟${day.overCapacity ? '（已有日程超额，本日不新增）' : ''}` });
      const list = contentEl.createEl('ul');
      const blocks = result.blocks.filter(b => b.date === day.date);
      if (!blocks.length) list.createEl('li', { text: '无工作块' });
      for (const block of blocks) {
        const item = list.createEl('li');
        item.createSpan({ text: `${clock(block.start)}–${endClock(block)} ${block.taskId}${block.completed ? '（已勾选，保留）' : block.locked ? '（锁定）' : ''} ` });
        const source = item.createEl('a', { text: block.title, href: '#' });
        source.addEventListener('click', event => { event.preventDefault(); void this.app.workspace.openLinkText(block.path, '', true); });
      }
    }
    if (result.unscheduled.length) {
      contentEl.createEl('h3', { text: '尚未安排' }); const list = contentEl.createEl('ul');
      for (const task of result.unscheduled) list.createEl('li', { text: `${task.taskId} · 剩余 ${task.remaining} 分钟 · ${task.reason}` });
    }
    if (this.preview.output !== null) {
      const detail = contentEl.createEl('details'); detail.createEl('summary', { text: '查看实际写入内容' });
      detail.createEl('pre', { text: this.preview.output });
    }
    const actions = contentEl.createDiv({ cls: 'auto-scheduler-actions' });
    const apply = actions.createEl('button', { text: '应用排程', cls: 'mod-cta' });
    apply.disabled = result.errors.length > 0 || this.preview.output === null;
    apply.addEventListener('click', () => {
      apply.disabled = true;
      void this.plugin.apply(this.preview, () => this.close()).finally(() => { apply.disabled = result.errors.length > 0 || this.preview.output === null; });
    });
    const cancel = actions.createEl('button', { text: '取消' }); cancel.addEventListener('click', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}
class SchedulerSettings extends PluginSettingTab {
  constructor(app: App, private plugin: AutoScheduler) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const settings = this.plugin.state.settings;
    containerEl.createEl('h2', { text: 'Auto Scheduler' });
    containerEl.createEl('p', { text: `本地时区：${timezone()}。只读源任务，预览确认后写入专用文件。初版不读取其他日历插件的事件。` });
    const text = (name: string, description: string, value: string, update: (value: string) => Partial<Settings>): void => {
      new Setting(containerEl).setName(name).setDesc(description).addText(input => input.setValue(value).onChange(value => { void this.plugin.updateSettings(update(value.trim())); }));
    };
    text('任务目录', '库内目录，仅扫描该目录下 Markdown', settings.taskFolder, taskFolder => ({ taskFolder }));
    text('固定日程文件', '格式：- YYYY-MM-DD HH:mm-HH:mm 标题；不存在时按空日程处理', settings.fixedFile, fixedFile => ({ fixedFile }));
    text('输出文件', '专用 Markdown；已有普通笔记不会被接管', settings.outputFile, outputFile => ({ outputFile }));
    text('工作日', '逗号分隔：0 为周日，1 为周一，…，6 为周六', Array.isArray(settings.weekdays) ? settings.weekdays.join(',') : String(settings.weekdays), value => ({ weekdays: value.split(',').map(v => v.trim() ? Number(v.trim()) : NaN) }));
    text('工作时段', '逗号分隔，如 09:00-12:00,14:00-18:00；15 分钟网格', Array.isArray(settings.periods) ? settings.periods.join(',') : String(settings.periods), value => ({ periods: value.split(',').map(v => v.trim()) }));
    for (const [field, name, description] of [
      ['dailyCapacity', '每日容量（分钟）', '包括工作时段中的固定日程、工作块及缓冲'],
      ['fixedBuffer', '固定日程两侧缓冲', '分钟，15 的倍数，可设 0'],
      ['blockBuffer', '工作块后缓冲', '分钟，15 的倍数，可设 0'],
    ] as const) text(name, description, String(settings[field]), value => ({ [field]: value ? Number(value) : NaN }));
    new Setting(containerEl).setName('输出格式').setDesc('Day Planner 模式使用复选框工作块及 scheduled 日期；不会修改源任务或每日笔记。').addDropdown(input => input.addOption('plain', '普通 Markdown 列表').addOption('day-planner', 'Day Planner').setValue(settings.outputMode).onChange(value => { void this.plugin.updateSettings({ outputMode: value as Settings['outputMode'] }); }));
    containerEl.createEl('p', { text: '工作块需保留完整 as-block 注释。改变设置后重新预览；剩余用时请在源任务中维护。' });
  }
}
