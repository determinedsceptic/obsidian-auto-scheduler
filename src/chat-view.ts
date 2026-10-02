import { ItemView, Notice, requestUrl, WorkspaceLeaf } from 'obsidian';
import type AutoScheduler from './main';
import { chat, endpoint } from './llm';
import type { ChatMessage } from './llm';
export const CHAT_VIEW = 'auto-scheduler-chat';
export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private busy = false;
  private closed = false;
  constructor(leaf: WorkspaceLeaf, private plugin: AutoScheduler) { super(leaf); }
  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return 'AI 任务助手'; }
  getIcon(): string { return 'calendar-clock'; }
  async onOpen(): Promise<void> { this.closed = false; this.render(); }
  async onClose(): Promise<void> { this.closed = true; this.messages = []; this.contentEl.empty(); }
  refresh(): void { this.render(); }
  private render(): void {
    if (this.closed) return;
    const root = this.contentEl; root.empty(); root.addClass('auto-scheduler-chat');
    root.createEl('h3', { text: 'AI 任务助手' });
    const config = this.plugin.state.llm;
    root.createEl('p', { text: `${config.model} · ${config.protocol}` });
    root.createEl('p', { text: '配置服务地址和模型：设置 → Auto Scheduler。只向所选服务发送对话及排程设置，不发送笔记内容。', cls: 'auto-scheduler-muted' });
    let host = '地址未配置'; try { host = new URL(endpoint(config)).origin; } catch { /* settings are validated before requests */ }
    const label = root.createEl('label', { text: `API 令牌（发送至 ${host}，仅当前会话保存）` });
    const token = root.createEl('input', { type: 'password', attr: { autocomplete: 'off', 'aria-label': 'API 令牌' } });
    label.htmlFor = token.id = 'auto-scheduler-token';
    token.value = this.plugin.apiToken; token.disabled = this.busy;
    token.addEventListener('input', () => { this.plugin.apiToken = token.value; });
    const log = root.createDiv({ cls: 'auto-scheduler-chat-log', attr: { 'aria-live': 'polite' } });
    for (const message of this.messages) {
      const row = log.createDiv({ cls: `auto-scheduler-message auto-scheduler-${message.role}` });
      row.createEl('strong', { text: message.role === 'user' ? '你' : '助手' });
      row.createEl('p', { text: message.content });
    }
    if (this.busy) log.createEl('p', { text: '正在生成任务…' });
    const input = root.createEl('textarea', { attr: { placeholder: '我有两门课要复习，每门预计2小时，很重要，帮我安排一下', 'aria-label': '任务对话', rows: '4', maxlength: '12000' } });
    input.disabled = this.busy;
    const actions = root.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: '发送', cls: 'mod-cta' }); send.disabled = this.busy;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: '清空对话' }); clear.disabled = this.busy;
    clear.addEventListener('click', () => { this.messages = []; this.render(); });
    log.scrollTop = log.scrollHeight;
  }
  private async send(value: string): Promise<void> {
    if (this.busy || !value.trim() || this.closed) return;
    const message = value.trim(); const config = { ...this.plugin.state.llm }; const settings = JSON.parse(JSON.stringify(this.plugin.state.settings));
    const configKey = JSON.stringify(config), settingsKey = JSON.stringify(settings);
    try { endpoint(config); if (!this.plugin.apiToken.trim()) throw new Error('请先填写 API 令牌'); }
    catch (error) { new Notice((error as Error).message); return; }
    const token = this.plugin.apiToken;
    this.messages.push({ role: 'user', content: message }); this.busy = true; this.render();
    try {
      const reply = await chat(config, token, this.messages, settings, new Date(), async (url, headers, body) => {
        const result = await requestUrl({ url, method: 'POST', headers, body, throw: false });
        return { status: result.status, json: result.status >= 200 && result.status < 300 ? result.json : {} };
      });
      if (this.closed) return;
      if (configKey !== JSON.stringify(this.plugin.state.llm) || settingsKey !== JSON.stringify(this.plugin.state.settings)) throw new Error('接口或排程设置已变化，请重新发送');
      this.messages.push({ role: 'assistant', content: reply.text });
      if (reply.tasks.length) {
        await this.plugin.previewAi(reply.tasks, () => {
          if (!this.closed) { this.messages.push({ role: 'assistant', content: '本地排程已应用，任务已记录到每日笔记。未安排的剩余任务保存在插件中；可重新预览或撤销最近一次排程。' }); this.render(); }
        });
      }
    } catch (error) {
      if (!this.closed) this.messages.push({ role: 'assistant', content: `未写入任务：${(error as Error).message}` });
    } finally { this.busy = false; this.render(); }
  }
}
