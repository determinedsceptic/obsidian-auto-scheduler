import { Credentials } from './credentials';
import type { SecretPort } from './credentials';
import { ProviderModal } from './provider-modal';
import { activeConfig, migrateByok, validateByok, validateProvider } from './providers';
import { ChatView, CHAT_VIEW } from './chat-view';
import { materializeTasks, validAiTasks } from './llm';
import { describeAiSchedule } from './ai-result';
import type { AiScheduleReply } from './ai-result';
import type { TaskDraft } from './llm';
import { validTracking } from './tracking';
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import { applyPreview, createPreview, timezone, undoLast } from './transaction';
import type { Preview, VaultPort, StatePort } from './transaction';
import { DEFAULT_SETTINGS, DEFAULT_LLM } from './types';
import type { ByokSettings, ProviderConfig, PluginState, Settings, UndoRecord } from './types';
import { clock, safeVaultPath } from './time';
import { OperationQueue } from './queue';
import { endClock } from './output';

class ObsidianVault implements VaultPort {
  constructor(private app: App) {}
  async listTasks(folder: string, excluded: string[]): Promise<string[]> {
    const path = normalizePath(folder);
    if (!this.app.vault.getAbstractFileByPath(path)) return [];
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
  const validEntry = (entry: import('./types').FileChange): boolean => safeVaultPath(entry.path) && entry.path.endsWith('.md')
    && (entry.before === null || typeof entry.before === 'string') && typeof entry.after === 'string'
    && (entry.restored === undefined || typeof entry.restored === 'string');
  return validEntry(record) && typeof record.createdAt === 'string'
    && (record.aiTasksBefore === undefined || validAiTasks(record.aiTasksBefore)) && (record.aiTasksAfter === undefined || validAiTasks(record.aiTasksAfter))
    && (record.entries === undefined || (Array.isArray(record.entries) && record.entries.length > 0 && record.entries.every(e => !!e && typeof e === 'object' && validEntry(e)) && new Set(record.entries.map(e => e.path)).size === record.entries.length));
}
export default class AutoScheduler extends Plugin {
  state: PluginState = { settings: { ...DEFAULT_SETTINGS }, undo: null, tracking: {}, aiTasks: [], llm: { ...DEFAULT_LLM } };
  credentials!: Credentials;
  get byok(): ByokSettings { return this.state.byok!; }
  get credentialMode(): string { return this.credentials.mode; }
  async getApiToken(): Promise<string> { activeConfig(this.byok); return this.credentials.get(this.byok.activeProviderId); }
  private operations = new OperationQueue();
  private vaultPort!: VaultPort;
  private storage: StatePort = {
    getTracking: () => this.state.tracking,
    getAiTasks: () => this.state.aiTasks,
    saveUndo: async (record, tracking, aiTasks) => {
      const next = { ...this.state, undo: record, aiTasks: aiTasks ?? this.state.aiTasks, tracking: tracking ?? this.state.tracking };
      await this.saveData(next); this.state = next;
    },
  };
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<PluginState> | null;
    this.state.settings = { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) };
    if (saved?.undo && validUndo(saved.undo)) this.state.undo = saved.undo;
    else if (saved?.undo) new Notice('Auto Scheduler：撤销记录格式异常，未启用自动恢复。请保留插件 data.json 备份。');
    if (saved?.tracking) {
      if (!validTracking(saved.tracking)) throw new Error('工作块跟踪数据异常，请保留 data.json 备份');
      this.state.tracking = saved.tracking;
    }
    this.state.llm = { protocol: saved?.llm?.protocol ?? DEFAULT_LLM.protocol, baseUrl: saved?.llm?.baseUrl ?? DEFAULT_LLM.baseUrl, model: saved?.llm?.model ?? DEFAULT_LLM.model };
    if (saved?.byok) { validateByok(saved.byok); this.state.byok = saved.byok; if (saved.byok.providers.length) this.state.llm = activeConfig(saved.byok); }
    else { this.state.byok = migrateByok(this.state.llm, crypto.randomUUID().replace(/-/g, '')); this.state.llm = activeConfig(this.state.byok); }
    const secretStorage = (this.app as App & { secretStorage?: SecretPort }).secretStorage;
    this.credentials = new Credentials(this.byok.namespace, secretStorage && typeof secretStorage.getSecret === 'function' && typeof secretStorage.setSecret === 'function' ? secretStorage : undefined);
    if (saved?.aiTasks) { if (!validAiTasks(saved.aiTasks)) throw new Error('AI 任务数据无效，请保留 data.json 备份'); this.state.aiTasks = saved.aiTasks; }
    if (!saved?.byok) await this.saveData(this.state);
    this.registerView(CHAT_VIEW, leaf => new ChatView(leaf, this));
    this.addCommand({ id: 'open-chat', name: '打开 AI 任务助手', callback: () => { void this.action(() => this.openChat()); } });
    this.vaultPort = new ObsidianVault(this.app);
    this.addSettingTab(new SchedulerSettings(this.app, this));
    this.addCommand({ id: 'preview-week', name: '预览一周排程', callback: () => { void this.action(async () => {
      const preview = await createPreview(this.vaultPort, this.state.settings, new Date(), this.state.tracking, false, this.state.aiTasks);
      new PreviewModal(this.app, preview, this).open();
    }); } });
    this.addCommand({ id: 'clean-daily-output', name: '清理每日排程格式', callback: () => { void this.action(async () => {
      if (this.state.settings.outputLocation !== 'daily' || !this.state.settings.cleanDaily) throw new Error('请先启用每日笔记与每日纯列表');
      const preview = await createPreview(this.vaultPort, this.state.settings, new Date(), this.state.tracking, true, this.state.aiTasks);
      new PreviewModal(this.app, preview, this).open();
    }); } });
    this.addCommand({ id: 'undo-last', name: '撤销最近一次排程', callback: () => { void this.action(async () => {
      await undoLast(this.vaultPort, this.storage, this.state.undo); new Notice('已撤销最近一次排程');
    }); } });
    this.addRibbonIcon('calendar-clock', '打开 AI 任务助手', () => { void this.action(() => this.openChat()); });
  }
  onunload(): void { this.credentials?.clearSession(); }
  async openChat(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) { const right = this.app.workspace.getRightLeaf(false); if (!right) throw new Error('无法打开侧栏'); leaf = right; await leaf.setViewState({ type: CHAT_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  refreshChats(): void { for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW)) if (leaf.view instanceof ChatView) leaf.view.refresh(); }
  openProvider(existing?: ProviderConfig, done?: () => void): void { new ProviderModal(this, existing, done).open(); }
  async selectModel(providerId: string, model: string): Promise<void> {
    await this.operations.run(async () => {
      const byok = { ...this.byok, activeProviderId: providerId, activeModel: model }; validateByok(byok);
      const next = { ...this.state, byok, llm: activeConfig(byok) }; await this.saveData(next); this.state = next; this.refreshChats();
    });
  }
  async saveProvider(provider: ProviderConfig, token: string): Promise<void> {
    await this.operations.run(async () => {
      validateProvider(provider);
      if (provider.requiresKey && !token.trim()) throw new Error('请填写本服务商的 API 令牌');
      const providers = this.byok.providers.filter(p => p.id !== provider.id); providers.push(provider);
      const byok = { ...this.byok, providers, activeProviderId: provider.id, activeModel: provider.models.includes(this.byok.activeModel) ? this.byok.activeModel : provider.models[0] }; validateByok(byok);
      const previousKey = await this.credentials.get(provider.id);
      await this.credentials.set(provider.id, token.trim());
      const next = { ...this.state, byok, llm: activeConfig(byok) };
      try { await this.saveData(next); } catch {
        try { await this.credentials.set(provider.id, previousKey); } catch { throw new Error('配置保存失败且令牌回滚失败，请在本机 Keychain 检查本服务商凭据'); }
        throw new Error('配置保存失败，已恢复原令牌');
      }
      this.state = next; this.refreshChats();
    });
  }
  async removeProvider(id: string): Promise<void> {
    await this.operations.run(async () => {
      const providers = this.byok.providers.filter(p => p.id !== id);
      const selected = providers.find(p => p.id === this.byok.activeProviderId) ?? providers[0];
      const byok = { ...this.byok, providers, activeProviderId: selected?.id ?? '', activeModel: selected?.models.includes(this.byok.activeModel) ? this.byok.activeModel : selected?.models[0] ?? '' }; validateByok(byok);
      const previousKey = await this.credentials.get(id); await this.credentials.set(id, '');
      const next = { ...this.state, byok, llm: selected ? activeConfig(byok) : { ...DEFAULT_LLM } };
      try { await this.saveData(next); } catch { await this.credentials.set(id, previousKey); throw new Error('移除失败，已恢复原令牌'); }
      this.state = next; this.refreshChats();
    });
  }
  async scheduleAi(drafts: TaskDraft[], expectedSettingsKey?: string): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (expectedSettingsKey !== undefined && JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('排程设置已变化，请重新发送');
      if (this.state.aiTasks.length + drafts.length > 10000) throw new Error('AI 任务数量超过上限');
      const settings = { ...this.state.settings, outputLocation: 'daily' as const, cleanDaily: true,
        outputMode: this.state.settings.outputMode === 'plain' ? 'day-planner' as const : this.state.settings.outputMode };
      const added = materializeTasks(drafts, settings, new Date(), crypto.randomUUID().replace(/-/g, ''));
      const preview = await createPreview(this.vaultPort, settings, new Date(), this.state.tracking, false, this.state.aiTasks, added);
      if (preview.result.errors.length) throw new Error(preview.result.errors.map(e => `${e.path}${e.line ? ':' + e.line : ''}：${e.message}`).join('\n'));
      const ids = new Set(added.map(t => t.id));
      if (!preview.result.blocks.some(b => ids.has(b.taskId))) throw new Error('未来七天没有可安排这些新任务的时间，未创建新任务。请调整工作时段、容量或截止时间后重试');
      let backupSaved = false;
      const storage: StatePort = {
        getTracking: this.storage.getTracking,
        getAiTasks: this.storage.getAiTasks,
        saveUndo: async (undo, tracking, aiTasks) => {
          const next = { ...this.state, settings, undo, tracking: tracking ?? this.state.tracking, aiTasks: aiTasks ?? this.state.aiTasks };
          await this.saveData(next); this.state = next; backupSaved = true;
        },
      };
      try {
        const result = await applyPreview(this.vaultPort, storage, preview, settings);
        return describeAiSchedule(preview, result.warning);
      } catch (error) {
        if (backupSaved) throw new Error(`排程写入未完成，可能已有部分日期写入；恢复备份已保存。请检查笔记并运行“撤销最近一次排程”。${(error as Error).message}`);
        throw error;
      }
    });
  }

  async openScheduledNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`日期笔记不存在：${path}`);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async action(work: () => Promise<void>): Promise<void> {
    // Serialize all writes, including rapid settings edits. Never discard keystrokes.
    await this.operations.run(work).catch(error => {
      new Notice(`Auto Scheduler：${(error as Error).message}`, 12000);
    });
  }
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    await this.action(async () => {
      const next = { ...this.state, settings: { ...this.state.settings, ...patch } };
      // Keep incomplete form values so users can edit several fields; preview validates them.
      await this.saveData(next); this.state = next;
    });
  }
  async apply(preview: Preview, done: () => void, originalSettingsKey?: string): Promise<void> {
    await this.action(async () => {
      if (originalSettingsKey !== undefined) {
        if (JSON.stringify(this.state.settings) !== originalSettingsKey) throw new Error('设置已变化，请重新生成预览');
        const next = { ...this.state, settings: preview.settings }; await this.saveData(next); this.state = next;
      }
      const result = await applyPreview(this.vaultPort, this.storage, preview, this.state.settings);
      new Notice(result.warning ?? (result.changed ? '排程已写入；可通过命令撤销' : '排程无变化，无需写入'), result.warning ? 12000 : 5000);
      done();
    });
  }
}
class PreviewModal extends Modal {
  constructor(app: App, private preview: Preview, private plugin: AutoScheduler, private applied?: () => void, private originalSettingsKey?: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('auto-scheduler-modal');
    const { contentEl } = this; const { result, settings, diff } = this.preview;
    contentEl.createEl('h2', { text: '一周排程预览' });
    contentEl.createEl('p', { text: `${this.preview.today} 起一周 · ${this.preview.timezone} · 输出：${settings.outputLocation === 'daily' ? settings.dailyFolder + '/YYYY-MM-DD.md' : settings.outputFile}` });
    contentEl.createEl('p', { text: '未锁定的本周工作块会被替换。保留手动移动的工作块，带元数据格式可用 locked=true 保留手动位置。纯列表模式支持勾选完成，编辑时间或标题前请先撤销。手写源任务的 remaining 需手动维护；AI 任务按勾选工作块计算未完成量。' });
    const creating = this.preview.aiTasksAfter.filter(t => !this.preview.aiTasksBefore.some(old => old.id === t.id));
    if (creating.length) {
      contentEl.createEl('h3', { text: '将创建的 AI 任务' });
      for (const t of creating) contentEl.createEl('p', { text: `${t.title} · ${t.remaining} 分钟 · 优先级 ${t.priority} · ${t.split ? '可拆分' : '连续完成'} · 最小块 ${t.min} 分钟` });
    }
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
        if (this.preview.aiTasksAfter.some(t => t.id === block.taskId)) { item.createSpan({ text: block.title }); continue; }
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
      void this.plugin.apply(this.preview, () => { this.close(); this.applied?.(); }, this.originalSettingsKey).finally(() => { apply.disabled = result.errors.length > 0 || this.preview.output === null; });
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
    containerEl.createEl('p', { text: `本地时区：${timezone()}。预览确认后写入专用文件或每日笔记的 Day planner 管理区。每日笔记中的手写时间段计入占用。` });
    const text = (name: string, description: string, value: string, update: (value: string) => Partial<Settings>): void => {
      new Setting(containerEl).setName(name).setDesc(description).addText(input => input.setValue(value).onChange(value => { void this.plugin.updateSettings(update(value.trim())); }));
    };
    containerEl.createEl('h3', { text: 'BYOK 服务商与模型' });
    containerEl.createEl('p', { text: `令牌保存方式：${this.plugin.credentialMode}。取消配置不保存；本机令牌不写入 data.json 或笔记。` });
    new Setting(containerEl).setName('添加服务商').setDesc('选择模板、填写令牌、测试并选择模型；支持手动模型 ID。').addButton(b => b.setButtonText('添加服务商').onClick(() => this.plugin.openProvider(undefined, () => this.display())));
    for (const provider of this.plugin.byok.providers) {
      new Setting(containerEl).setName(provider.name).setDesc(`${provider.protocol} · ${provider.baseUrl} · ${provider.requiresKey ? '需要令牌' : '令牌可选'} · ${provider.models.join(', ')}`)
        .addButton(b => b.setButtonText('编辑').onClick(() => this.plugin.openProvider(provider, () => this.display())))
        .addButton(b => b.setButtonText('移除').onClick(() => {
          const modal = new Modal(this.app); modal.contentEl.createEl('h3', { text: `移除 ${provider.name}？` });
          modal.contentEl.createEl('p', { text: '将移除此服务商、模型及本插件保存的令牌，不影响已有任务和笔记。' });
          modal.contentEl.createEl('button', { text: '确认移除' }).addEventListener('click', () => { void this.plugin.removeProvider(provider.id).then(() => { modal.close(); this.display(); }).catch(error => new Notice((error as Error).message)); });
          modal.contentEl.createEl('button', { text: '取消' }).addEventListener('click', () => modal.close()); modal.open();
        }));
    }
    text('任务目录', '库内目录，仅扫描该目录下 Markdown', settings.taskFolder, taskFolder => ({ taskFolder }));
    text('固定日程文件', '格式：- YYYY-MM-DD HH:mm-HH:mm 标题；不存在时按空日程处理', settings.fixedFile, fixedFile => ({ fixedFile }));
    text('输出文件', '专用 Markdown；已有普通笔记不会被接管', settings.outputFile, outputFile => ({ outputFile }));
    new Setting(containerEl).setName('输出位置').addDropdown(input => input.addOption('single', '专用文件').addOption('daily', '每日笔记：Day planner').setValue(settings.outputLocation).onChange(value => { void this.plugin.updateSettings({ outputLocation: value as Settings['outputLocation'] }); }));
    new Setting(containerEl).setName('每日纯列表').setDesc('日期文件只输出普通任务列表，管理数据保存到插件数据中；关闭以输出 Gantt 日期字段。').addToggle(input => input.setValue(settings.cleanDaily).onChange(cleanDaily => { void this.plugin.updateSettings({ cleanDaily }); }));
    text('每日笔记目录', 'YYYY-MM-DD.md；保留 Day planner 下的手写内容和其他章节', settings.dailyFolder, dailyFolder => ({ dailyFolder }));
    text('Gantt 任务前缀', '与 Gantt Calendar 的全局任务过滤器一致，默认 🎯；可清空', settings.ganttFilter, ganttFilter => ({ ganttFilter }));
    text('工作日', '逗号分隔：0 为周日，1 为周一，…，6 为周六', Array.isArray(settings.weekdays) ? settings.weekdays.join(',') : String(settings.weekdays), value => ({ weekdays: value.split(',').map(v => v.trim() ? Number(v.trim()) : NaN) }));
    text('工作时段', '逗号分隔，如 09:00-12:00,14:00-18:00；15 分钟网格', Array.isArray(settings.periods) ? settings.periods.join(',') : String(settings.periods), value => ({ periods: value.split(',').map(v => v.trim()) }));
    for (const [field, name, description] of [
      ['dailyCapacity', '每日容量（分钟）', '包括工作时段中的固定日程、工作块及缓冲'],
      ['fixedBuffer', '固定日程两侧缓冲', '分钟，15 的倍数，可设 0'],
      ['blockBuffer', '工作块后缓冲', '分钟，15 的倍数，可设 0'],
    ] as const) text(name, description, String(settings[field]), value => ({ [field]: value ? Number(value) : NaN }));
    new Setting(containerEl).setName('输出格式').setDesc('Gantt 使用完整 start/scheduled/due 日期时间；每日模式请选择 Day Planner 或 Gantt。').addDropdown(input => input.addOption('plain', '普通 Markdown 列表').addOption('day-planner', 'Day Planner').addOption('gantt', 'Gantt Calendar（Dataview）').setValue(settings.outputMode).onChange(value => { void this.plugin.updateSettings({ outputMode: value as Settings['outputMode'] }); }));
    containerEl.createEl('p', { text: '工作块需保留完整 as-block 注释或结构化元数据。Gantt 锁定字段为 locked=true。改变设置后重新预览；剩余用时请在源任务中维护。' });
  }
}
