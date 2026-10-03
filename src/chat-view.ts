import type { DailySnapshot } from './daily-edit';
import { ItemView, Notice, requestUrl, WorkspaceLeaf } from 'obsidian';
import type AutoScheduler from './main';
import { chat, endpoint } from './llm';
import { modelChoices } from './providers';
import type { ChatMessage } from './llm';
import type { ScheduledNote } from './ai-result';
export const CHAT_VIEW = 'auto-scheduler-chat';
export class ChatView extends ItemView {
  private messages: (ChatMessage & { notes?: ScheduledNote[] })[] = [];
  private draftText = '';
  private busy = false;
  private closed = false;
  private modelBusy = false;
  private modelStatus = '';
  private modelLoad: Promise<void> | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: AutoScheduler) { super(leaf); }
  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return 'AI scheduling assistant'; }
  getIcon(): string { return 'calendar-clock'; }
  async onOpen(): Promise<void> { this.closed = false; this.render(); this.modelLoad = this.loadModels(); }
  async onClose(): Promise<void> { this.closed = true; this.messages = []; this.draftText = ''; this.contentEl.empty(); }
  refresh(): void { this.render(); }
  private async loadModels(): Promise<void> {
    if (this.closed || this.modelBusy || !this.plugin.byok.providers.length) return;
    this.modelBusy = true; this.modelStatus = 'Loading provider models…'; this.render();
    try {
      const count = await this.plugin.refreshModels(this.plugin.byok.activeProviderId);
      this.modelStatus = `${count} provider models loaded. Tool support depends on the model.`;
    } catch (error) { this.modelStatus = `Model list not refreshed: ${(error as Error).message}`; }
    finally { this.modelBusy = false; this.render(); }
  }
  private render(): void {
    if (this.closed) return;
    const root = this.contentEl; root.empty(); root.addClass('auto-scheduler-chat');
    const header = root.createDiv({ cls: 'auto-scheduler-chat-header' });
    const configure = header.createEl('button', { text: 'Configure provider / API key' }); configure.disabled = this.busy;
    configure.addEventListener('click', () => this.plugin.openProvider(this.plugin.byok.providers.find(p => p.id === this.plugin.byok.activeProviderId)));
    if (this.plugin.byok.providers.length) {
      const picker = header.createEl('label', { cls: 'auto-scheduler-chat-model' });
      picker.createSpan({ text: 'Model' });
      const select = picker.createEl('select', { attr: { 'aria-label': 'Chat model' } });
      for (const provider of this.plugin.byok.providers) for (const model of modelChoices(provider)) {
        const value = JSON.stringify([provider.id, model]);
        select.createEl('option', { text: `${provider.name} / ${model}`, value });
      }
      select.value = JSON.stringify([this.plugin.byok.activeProviderId, this.plugin.byok.activeModel]);
      select.disabled = this.busy || this.modelBusy;
      select.addEventListener('change', () => {
        const [providerId, model] = JSON.parse(select.value) as [string, string];
        const previous = this.plugin.byok.activeProviderId;
        void this.plugin.selectModel(providerId, model).then(() => { if (previous !== providerId) return this.loadModels(); }).catch(error => { new Notice((error as Error).message); this.render(); });
      });
    }
    if (this.plugin.byok.providers.length) {
      const refresh = header.createEl('button', { text: 'Refresh models', cls: 'auto-scheduler-refresh-models' }); refresh.disabled = this.busy || this.modelBusy;
      refresh.addEventListener('click', () => { void this.loadModels(); });
      if (this.modelStatus) header.createEl('small', { text:this.modelStatus, cls:'auto-scheduler-model-status', attr:{'aria-live':'polite'} });
    }
    const log = root.createDiv({ cls: 'auto-scheduler-chat-log', attr: { 'aria-live': 'polite' } });
    for (const message of this.messages) {
      const row = log.createDiv({ cls: `auto-scheduler-message auto-scheduler-${message.role}` });
      row.createEl('strong', { text: message.role === 'user' ? 'You' : 'Assistant' });
      row.createEl('p', { text: message.content });
      const copy = row.createEl('button', { text: 'Copy', cls: 'auto-scheduler-message-copy', attr: { 'aria-label': 'Copy message' } });
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(message.content).then(() => { copy.textContent = 'Copied'; }, () => new Notice('Could not copy. Select the text and use your system copy shortcut.'));
      });
      if (message.notes?.length) {
        const links = row.createDiv({ cls: 'auto-scheduler-note-links' });
        for (const note of message.notes) {
          const link = links.createEl('a', { text: `Open ${note.date}`, href: '#', cls: 'internal-link' });
          link.addEventListener('click', e => { e.preventDefault(); void this.plugin.openScheduledNote(note.path).catch(error => new Notice(`Could not open daily note: ${(error as Error).message}`)); });
        }
      }
    }
    if (this.busy) log.createEl('p', { text: 'Reading and scheduling…' });
    const composer = root.createDiv({ cls: 'auto-scheduler-composer' });
    const input = composer.createEl('textarea', { attr: { placeholder: 'Describe a task, appointment or habit…', 'aria-label': 'Task conversation', rows: '3', maxlength: '12000' } });
    input.value = this.draftText; input.addEventListener('input', () => { this.draftText = input.value; });
    input.disabled = this.busy;
    const actions = composer.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' }); send.disabled = this.busy || !this.plugin.byok.providers.length;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: 'Clear chat' }); clear.disabled = this.busy;
    clear.addEventListener('click', () => { this.messages = []; this.draftText = ''; this.render(); });
    log.scrollTop = log.scrollHeight;
  }
  private async send(value: string): Promise<void> {
    if (this.busy || !value.trim() || this.closed) return;
    const message = value.trim(); const config = { ...this.plugin.state.llm }; const settings = JSON.parse(JSON.stringify(this.plugin.state.settings));
    const providerId = this.plugin.byok.activeProviderId;
    const configKey = JSON.stringify(config), settingsKey = JSON.stringify(settings);
    this.busy = true; let token: string;
    try { endpoint(config); token = await this.plugin.getApiToken(); if (config.requiresKey !== false && !token.trim()) throw new Error('First select Configure provider / API key'); }
    catch (error) { this.busy = false; new Notice((error as Error).message); return; }
    if (this.closed) { this.busy = false; return; }
    if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm)) { this.busy = false; new Notice('Model settings changed. Send your message again.'); this.render(); return; }
    this.draftText = ''; this.messages.push({ role: 'user', content: message }); this.busy = true; this.render();
    try {
      const reads = new Map<string, DailySnapshot>();
      const reply = await chat(config, token, this.messages.map(({ role, content }) => ({ role, content })), settings, new Date(), async (url, headers, body) => {
        const result = await requestUrl({ url, method: 'POST', headers, body, throw: false });
        return { status: result.status, json: result.status >= 200 && result.status < 300 ? result.json : {} };
      }, 60000, async date => {
        if (this.closed) throw new Error('Chat was closed');
        const snapshot = await this.plugin.readPlan(date, settingsKey); reads.set(date, snapshot); return snapshot.read;
      });
      if (this.closed) return;
      if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm) || settingsKey !== JSON.stringify(this.plugin.state.settings)) throw new Error('Provider or scheduling settings changed. Send your message again.');
      if (reply.revision || reply.guidelines?.length || reply.tasks.length || reply.habits.length || reply.events.length) {
        const mixed = [reply.tasks, reply.habits, reply.events].filter(a => a.length).length > 1;
        const result = reply.revision ? await this.plugin.revisePlan(reads.get(reply.revision.date)!, reply.revision.edits, settingsKey, reply.guidelines) : mixed || reply.guidelines?.length ? await this.plugin.schedulePlan(reply.tasks, reply.habits, reply.events, settingsKey, reply.guidelines) : reply.events.length ? await this.plugin.scheduleEvents(reply.events, settingsKey) : reply.habits.length ? await this.plugin.scheduleHabits(reply.habits, settingsKey) : await this.plugin.scheduleAi(reply.tasks, settingsKey);
        if (reply.defaultsUsed.length) result.text += `\nDefault duration (${settings.defaultEventDuration} min) used for: ${reply.defaultsUsed.join(', ')}.`;
        if (!this.closed) { this.messages.push({ role: 'assistant', content: result.text, notes: result.notes }); this.render(); }
        if (!this.closed && result.notes.length) {
          try { await this.plugin.openScheduledNote(result.notes[0].path); }
          catch (error) { if (!this.closed) this.messages.push({ role: 'assistant', content: `Schedule saved, but the daily note could not be opened: ${(error as Error).message}` }); }
        }
      } else this.messages.push({ role: 'assistant', content: reply.text });
    } catch (error) {
      if (!this.closed) this.messages.push({ role: 'assistant', content: `Request failed: ${(error as Error).message}` });
    } finally { this.busy = false; this.render(); }
  }
}
