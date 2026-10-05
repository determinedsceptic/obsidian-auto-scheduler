import type { HabitIndexSnapshot } from './habit-index';
import type { DailySnapshot } from './daily-edit';
import { ItemView, Notice, requestUrl, WorkspaceLeaf } from 'obsidian';
import type AutoScheduler from './main';
import { chat, endpoint } from './llm';
import { modelChoices } from './providers';
import type { ChatMessage } from './llm';
import type { ScheduledNote } from './ai-result';
export const CHAT_VIEW = 'auto-scheduler-chat';
type ChatEntry = ChatMessage & { notes?: ScheduledNote[]; failed?: boolean };
export interface ChatConversation { id:string; messages:ChatEntry[]; draft:string }
export class ChatView extends ItemView {
  private messages: ChatEntry[] = [];
  private conversations: ChatConversation[];
  private conversationId: string;
  private pendingUser?: ChatEntry;
  private draftText = '';
  private busy = false;
  private requestStatus = '';
  private generation = 0;
  private activeJob: number | null = null;
  private applying = false;
  private requestAbort?: AbortController;
  private closed = false;
  private modelBusy = false;
  private modelStatus = '';
  private modelLoad: Promise<void> | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: AutoScheduler) {
    super(leaf); this.conversations=plugin.chatHistory.sessions;this.conversationId=plugin.chatHistory.activeId;
    const current=this.conversations.find(c=>c.id===this.conversationId);
    if(current){this.messages=current.messages;this.draftText=current.draft;}
  }
  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return 'AI scheduling assistant'; }
  getIcon(): string { return 'calendar-clock'; }
  async onOpen(): Promise<void> { this.closed = false; this.render(); this.modelLoad = this.loadModels(); }
  async onClose(): Promise<void> { this.cancelPending(true);this.saveConversation();this.closed = true;this.contentEl.empty(); }
  private saveConversation(): void {
    const current=this.conversations.find(c=>c.id===this.conversationId);
    if(current){current.messages=this.messages;current.draft=this.draftText;}
    else this.conversations.push({id:this.conversationId,messages:this.messages,draft:this.draftText});
    this.plugin.chatHistory.activeId=this.conversationId;
  }
  private cancelPending(restoreDraft=false): void {
    if(restoreDraft && this.pendingUser){
      this.pendingUser.failed=true;
      if(this.applying)this.messages.push({role:'assistant',content:'Schedule save was already in progress. Check daily notes before resending.',failed:true});
      else {this.draftText=this.pendingUser.content;this.messages.push({role:'assistant',content:'Request cancelled. The draft is available to resend.',failed:true});}
    }
    this.pendingUser=undefined;
    this.generation++;
    this.requestAbort?.abort(); this.requestAbort = undefined;
    if (!this.applying) { this.activeJob = null; this.busy = false; this.requestStatus = ''; }
    else this.requestStatus = 'Finishing the current schedule save…';
  }
  newChat(): void {
    if(this.applying){new Notice('Wait for the current schedule save to finish');return;}
    this.cancelPending(true);this.saveConversation();
    this.conversationId=crypto.randomUUID();this.messages=[];this.draftText='';this.render();
  }
  private switchConversation(id:string):void {
    if(this.applying||id===this.conversationId)return;
    const target=this.conversations.find(c=>c.id===id);if(!target)return;
    this.cancelPending(true);this.saveConversation();this.conversationId=id;
    this.messages=target.messages;this.draftText=target.draft;this.render();
  }
  clearChat(): void {
    this.cancelPending();this.messages=[];this.draftText='';this.saveConversation();this.render();
  }
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
    this.saveConversation();
    const root = this.contentEl; root.empty(); root.addClass('auto-scheduler-chat');
    const header = root.createDiv({ cls: 'auto-scheduler-chat-header' });
    const configure = header.createEl('button', { text: 'Configure provider / API key' }); configure.disabled = this.busy;
    configure.addEventListener('click', () => this.plugin.openProvider(this.plugin.byok.providers.find(p => p.id === this.plugin.byok.activeProviderId)));
    const sessions=header.createDiv({cls:'auto-scheduler-conversations'});
    const start=sessions.createEl('button',{text:'New chat',attr:{'title':'Start a separate conversation. Saved schedules remain.'}});
    start.disabled=this.applying;start.addEventListener('click',()=>this.newChat());
    if(this.conversations.length>1){
      const select=sessions.createEl('select',{attr:{'aria-label':'Conversation','title':'Conversations are kept in memory until the plugin reloads.'}});
      for(const [index,conversation] of this.conversations.entries()){
        const title=conversation.messages.find(m=>m.role==='user')?.content.replace(/\s+/g,' ').slice(0,60)||`New chat ${index+1}`;
        select.createEl('option',{text:title,value:conversation.id});
      }
      select.value=this.conversationId;select.disabled=this.applying;
      select.addEventListener('change',()=>this.switchConversation(select.value));
    }
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
      if (message.failed && message.content.includes('HTTP 429') && new URL(this.plugin.state.llm.baseUrl).hostname === 'api.openai.com') {
        row.createEl('a', {text:'Open API limits', href:'https://platform.openai.com/settings/organization/limits', attr:{target:'_blank',rel:'noopener noreferrer'}});
      }
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
    if (this.busy) log.createEl('p', { text: this.requestStatus || 'Reading and scheduling…' });
    const composer = root.createDiv({ cls: 'auto-scheduler-composer' });
    const input = composer.createEl('textarea', { attr: { placeholder: 'Describe a task, appointment or habit…', 'aria-label': 'Task conversation', rows: '3', maxlength: '12000' } });
    input.value = this.draftText; input.addEventListener('input', () => { this.draftText = input.value; this.saveConversation(); });
    input.disabled = this.busy;
    const actions = composer.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' }); send.disabled = this.busy || !this.plugin.byok.providers.length;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: 'Clear', attr: {'aria-label':'Clear conversation and cancel pending request','title':'Clear conversation and cancel pending request. Saved schedules remain.'} });
    clear.addEventListener('click', () => this.clearChat());
    log.scrollTop = log.scrollHeight;
  }
  private async send(value: string): Promise<void> {
    if (this.busy || !value.trim() || this.closed) return;
    const message = value.trim(); const config = { ...this.plugin.state.llm }; const settings = JSON.parse(JSON.stringify(this.plugin.state.settings));
    const providerId = this.plugin.byok.activeProviderId;
    const configKey = JSON.stringify(config), settingsKey = JSON.stringify(settings);
    const job = ++this.generation; this.activeJob = job;
    const controller = new AbortController(); this.requestAbort = controller;
    const current = () => !this.closed && this.generation === job;
    this.busy = true; let token: string;
    try { endpoint(config); token = await this.plugin.getApiToken(); if (config.requiresKey !== false && !token.trim()) throw new Error('First select Configure provider / API key'); }
    catch (error) { if (current()) { this.busy = false; this.activeJob = null; new Notice((error as Error).message); } return; }
    if (!current()) return;
    if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm)) { this.busy = false; new Notice('Model settings changed. Send your message again.'); this.render(); return; }
    const userMessage: ChatMessage & { failed?: boolean } = { role: 'user', content: message };
    this.draftText = ''; this.pendingUser=userMessage; this.messages.push(userMessage); this.busy = true; this.render();
    let modelFinished = false;
    try {
      const reads = new Map<string, DailySnapshot>(); let habitRead:HabitIndexSnapshot|undefined;
      const reply = await chat(config, token, this.messages.filter(m => !m.failed).map(({ role, content }) => ({ role, content })), settings, new Date(), async (url, headers, body) => {
        const result = await requestUrl({ url, method: 'POST', headers, body, throw: false });
        let json: unknown = {};
        try { json = result.json; } catch { /* Non-JSON provider errors use status/headers. */ }
        return { status: result.status, json, headers: result.headers };
      }, 60000, async date => {
        if (!current()) throw new Error('Chat was closed or cleared');
        const snapshot = await this.plugin.readPlan(date, settingsKey); reads.set(date, snapshot); return snapshot.read;
      }, async()=>{
        if(!current())throw Error('Chat was closed or cleared');
        habitRead=await this.plugin.readHabits(settingsKey);return habitRead.index;
      }, { signal: controller.signal, cancelled: () => !current(), onRetry: (delay, retry) => {
        this.requestStatus = `Provider rate limit. Retrying in ${Math.ceil(delay / 1000)}s (${retry}/2)…`; this.render();
      } });
      modelFinished = true;
      if (!current()) return;
      this.requestStatus = ''; this.render();
      if (providerId !== this.plugin.byok.activeProviderId || configKey !== JSON.stringify(this.plugin.state.llm) || settingsKey !== JSON.stringify(this.plugin.state.settings)) throw new Error('Provider or scheduling settings changed. Send your message again.');
      if (reply.scheduleExistingHabits || reply.revision || reply.guidelines?.length || reply.tasks.length || reply.habits.length || reply.events.length) {
        this.applying = true; this.render();
        const mixed = [reply.tasks, reply.habits, reply.events].filter(a => a.length).length > 1;
        const result = reply.scheduleExistingHabits ? await this.plugin.scheduleExistingHabits(habitRead!,settingsKey) : reply.revision ? await this.plugin.revisePlan(reads.get(reply.revision.date)!, reply.revision.edits, settingsKey, reply.guidelines, reply.guidelineFiles) : mixed || reply.guidelines?.length ? await this.plugin.schedulePlan(reply.tasks, reply.habits, reply.events, settingsKey, reply.guidelines, reply.guidelineFiles) : reply.events.length ? await this.plugin.scheduleEvents(reply.events, settingsKey) : reply.habits.length ? await this.plugin.scheduleHabits(reply.habits, settingsKey) : await this.plugin.scheduleAi(reply.tasks, settingsKey);
        for (const task of reply.tasks) if(task.estimateBasis&&!task.rollingMinutes) result.text += `\n${task.title}: ${task.minutes} min — ${task.estimateBasis}`;
        if (reply.defaultsUsed.length) result.text += `\nDefault duration (${settings.defaultEventDuration} min) used for: ${reply.defaultsUsed.join(', ')}.`;
        if (current()) { this.messages.push({ role: 'assistant', content: result.text, notes: result.notes }); this.render(); }
        if (current() && result.notes.length) {
          try { await this.plugin.openScheduledNote(result.notes[0].path); }
          catch (error) { if (current()) this.messages.push({ role: 'assistant', content: `Schedule saved, but the daily note could not be opened: ${(error as Error).message}` }); }
        }
      } else this.messages.push({ role: 'assistant', content: reply.text });
    } catch (error) {
      if (current()) {
        if (!modelFinished) { this.draftText = message; userMessage.failed = true; }
        this.messages.push({ role: 'assistant', content: `Request failed: ${(error as Error).message}`, failed: true });
      }
    } finally {
      if (this.activeJob === job) { this.activeJob = null; this.pendingUser=undefined; this.busy = false; this.applying = false; this.requestStatus = ''; if (this.requestAbort === controller) this.requestAbort = undefined; this.render(); }
    }
  }
}
