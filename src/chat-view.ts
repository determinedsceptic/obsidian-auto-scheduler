import { ItemView, Notice, requestUrl, WorkspaceLeaf } from 'obsidian';
import type AutoScheduler from './main';
import { chat, endpoint } from './llm';
import type { ChatMessage } from './llm';
import type { ScheduledNote } from './ai-result';
export const CHAT_VIEW = 'auto-scheduler-chat';
export class ChatView extends ItemView {
  private messages: (ChatMessage & { notes?: ScheduledNote[] })[] = [];
  private draftText = '';
  private busy = false;
  private closed = false;
  constructor(leaf: WorkspaceLeaf, private plugin: AutoScheduler) { super(leaf); }
  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return 'AI 任务助手'; }
  getIcon(): string { return 'calendar-clock'; }
  async onOpen(): Promise<void> { this.closed = false; this.render(); }
  async onClose(): Promise<void> { this.closed = true; this.messages = []; this.draftText = ''; this.contentEl.empty(); }
  refresh(): void { this.render(); }
  private render(): void {
    if (this.closed) return;
    const root = this.contentEl; root.empty(); root.addClass('auto-scheduler-chat');
    const header = root.createDiv({ cls: 'auto-scheduler-chat-header' });
    const configure = header.createEl('button', { text: '配置服务商/API令牌' }); configure.disabled = this.busy;
    configure.addEventListener('click', () => this.plugin.openProvider(this.plugin.byok.providers.find(p => p.id === this.plugin.byok.activeProviderId)));
    const log = root.createDiv({ cls: 'auto-scheduler-chat-log', attr: { 'aria-live': 'polite' } });
    for (const message of this.messages) {
      const row = log.createDiv({ cls: `auto-scheduler-message auto-scheduler-${message.role}` });
      row.createEl('strong', { text: message.role === 'user' ? '你' : '助手' });
      row.createEl('p', { text: message.content });
      if (message.notes?.length) {
        const links = row.createDiv({ cls: 'auto-scheduler-note-links' });
        for (const note of message.notes) {
          const link = links.createEl('a', { text: `打开 ${note.date}`, href: '#', cls: 'internal-link' });
          link.addEventListener('click', e => { e.preventDefault(); void this.plugin.openScheduledNote(note.path).catch(error => new Notice(`打开日期笔记失败：${(error as Error).message}`)); });
        }
      }
    }
    if (this.busy) log.createEl('p', { text: '正在生成任务并安排时间…' });
    const composer = root.createDiv({ cls: 'auto-scheduler-composer' });
    const input = composer.createEl('textarea', { attr: { placeholder: '描述任务、预计用时与重要性…', 'aria-label': '任务对话', rows: '3', maxlength: '12000' } });
    input.value = this.draftText; input.addEventListener('input', () => { this.draftText = input.value; });
    input.disabled = this.busy;
    const actions = composer.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: '发送', cls: 'mod-cta' }); send.disabled = this.busy || !this.plugin.byok.providers.length;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: '清空对话' }); clear.disabled = this.busy;
    clear.addEventListener('click', () => { this.messages = []; this.draftText = ''; this.render(); });
    log.scrollTop = log.scrollHeight;
  }
  private async send(value: string): Promise<void> {
    if (this.busy || !value.trim() || this.closed) return;
    const message = value.trim(); const config = { ...this.plugin.state.llm }; const settings = JSON.parse(JSON.stringify(this.plugin.state.settings));
    const providerId = this.plugin.byok.activeProviderId;
    const configKey = JSON.stringify(config), settingsKey = JSON.stringify(settings);
    this.busy = true; let token: string;
    try { endpoint(config); token = await this.plugin.getApiToken(); if (config.requiresKey !== false && !token.trim()) throw new Error('请先点击配置服务商 / API 令牌'); }
    catch (error) { this.busy = false; new Notice((error as Error).message); return; }
    if (this.closed) { this.busy = false; return; }
    if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm)) { this.busy = false; new Notice('模型配置已变化，请重新发送'); this.render(); return; }
    this.draftText = ''; this.messages.push({ role: 'user', content: message }); this.busy = true; this.render();
    try {
      const reply = await chat(config, token, this.messages.map(({ role, content }) => ({ role, content })), settings, new Date(), async (url, headers, body) => {
        const result = await requestUrl({ url, method: 'POST', headers, body, throw: false });
        return { status: result.status, json: result.status >= 200 && result.status < 300 ? result.json : {} };
      });
      if (this.closed) return;
      if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm) || settingsKey !== JSON.stringify(this.plugin.state.settings)) throw new Error('接口或排程设置已变化，请重新发送');
      if (reply.tasks.length) {
        const result = await this.plugin.scheduleAi(reply.tasks, settingsKey);
        if (!this.closed) { this.messages.push({ role: 'assistant', content: result.text, notes: result.notes }); this.render(); }
        if (!this.closed && result.notes.length) {
          try { await this.plugin.openScheduledNote(result.notes[0].path); }
          catch (error) { if (!this.closed) this.messages.push({ role: 'assistant', content: `排程已写入，但打开日期笔记失败：${(error as Error).message}` }); }
        }
      } else this.messages.push({ role: 'assistant', content: reply.text });
    } catch (error) {
      if (!this.closed) this.messages.push({ role: 'assistant', content: `任务处理失败：${(error as Error).message}` });
    } finally { this.busy = false; this.render(); }
  }
}
