import { isUndoCommand } from './chat-commands';
import { ItemView, Notice, requestUrl, WorkspaceLeaf } from 'obsidian';
import type AutoScheduler from './main';
import { endpoint } from './llm';
import { runAgent } from './agent-harness';
import { agentSettings } from './agent-settings';
import type { OperationReceipt } from './agent-types';
import { modelChoices } from './providers';
import type { ChatMessage } from './llm';
import type { ScheduledNote } from './ai-result';
export const CHAT_VIEW = 'auto-scheduler-chat';
type ChatEntry = ChatMessage & { notes?: ScheduledNote[]; failed?: boolean; receipt?:OperationReceipt };
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
      if(this.applying)this.messages.push({role:'assistant',content:'A commit is already in progress. Its host result will be kept in this conversation.',failed:true});
      else {this.draftText=this.pendingUser.content;this.messages.push({role:'assistant',content:'Request cancelled. The draft is available to resend.',failed:true});}
    }
    this.pendingUser=undefined;
    this.generation++;
    this.requestAbort?.abort(); this.requestAbort = undefined;
    if (!this.applying) { this.activeJob = null; this.busy = false; this.requestStatus = ''; }
    else this.requestStatus = 'Finishing the current operation…';
  }
  newChat(): void {
    if(this.applying){new Notice('Wait for the current operation to finish');return;}
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
    const undo = header.createEl('button', { text: 'Undo last operation' });
    undo.disabled = this.busy || !this.plugin.state.undo;
    undo.addEventListener('click', () => { void this.undoFromChat(); });
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
      row.createEl('strong', { text: message.receipt ? 'Host result' : message.role === 'user' ? 'You' : 'Assistant' });
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
    const input = composer.createEl('textarea', { attr: { placeholder: 'Edit notes or ask to arrange time…', 'aria-label': 'Task conversation', rows: '3', maxlength: '12000' } });
    input.value = this.draftText; input.addEventListener('input', () => { this.draftText = input.value; this.saveConversation(); });
    input.disabled = this.busy;
    const actions = composer.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' }); send.disabled = this.busy;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: 'Clear', attr: {'aria-label':'Clear conversation and cancel pending request','title':'Clear conversation and cancel pending request. Saved schedules remain.'} });
    clear.addEventListener('click', () => this.clearChat());
    log.scrollTop = log.scrollHeight;
  }
  private async undoFromChat(message?:string):Promise<void> {
    if(this.busy||this.closed)return;
    const conversationId=this.conversationId;
    const job=++this.generation;this.activeJob=job;
    const current=()=>!this.closed&&this.generation===job;
    const undoKey=JSON.stringify(this.plugin.state.undo);
    this.busy=true;this.applying=true;this.requestStatus='Undoing last operation…';
    if(message){this.messages.push({role:'user',content:message});this.draftText='';}
    this.render();
    const publish=(entry:ChatEntry)=>{const messages=current()?this.messages:this.conversations.find(conversation=>conversation.id===conversationId)?.messages;messages?.push(entry);if(!this.closed&&this.conversationId===conversationId)this.render();};
    try {
      const result=await this.plugin.undoSchedule(undoKey);
      publish({role:'assistant',content:result.text,notes:result.notes,receipt:result.receipt});
    } catch(error) {
      publish({role:'assistant',content:`Undo failed: ${(error as Error).message}`,failed:true});
    } finally {
      if(this.activeJob===job){this.activeJob=null;this.busy=false;this.applying=false;this.requestStatus='';this.saveConversation();if(!this.closed)this.render();}
    }
  }
  private async send(value: string): Promise<void> {
    if (this.busy || !value.trim() || this.closed) return;
    const message = value.trim();
    if(isUndoCommand(message)){await this.undoFromChat(message);return;}
    const config = { ...this.plugin.state.llm }; const settings = JSON.parse(JSON.stringify(this.plugin.state.settings));
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
    const conversationId = this.conversationId;
    let modelFinished = false;
    try {
      const session=await this.plugin.agentSession(settingsKey,()=>!current());
      const options=agentSettings(this.plugin.state.agent);
      let reported=0;
      const publishReceipts=()=>{
        for(const receipt of session.runtime.receipts.slice(reported)){
          reported++;
          const notes=receipt.changedFiles.filter(path=>/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)).map(path=>({path,date:path.slice(-13,-3)}));
          const messages = current() ? this.messages : this.conversations.find(conversation=>conversation.id===conversationId)?.messages;
          messages?.push({role:'assistant',content:`${receipt.status}: ${receipt.summary}\nFiles: ${receipt.changedFiles.join(', ')||'none'}${receipt.stateChanges.length?'\nPlugin state: '+receipt.stateChanges.join(', '):''}${receipt.warnings.length?'\n'+receipt.warnings.join('\n'):''}`,notes,receipt,failed:['failed','conflict','partial'].includes(receipt.status)});
        }
        if(!this.closed&&this.conversationId===conversationId)this.render();
      };
      const reply=await runAgent(config,token,this.messages.filter(m=>!m.failed).map(({role,content})=>({role,content})),session.instructions,session.runtime,async(url,headers,body)=>{
        const result=await requestUrl({url,method:'POST',headers,body,throw:false});let json:unknown={};
        try{json=result.json;}catch{/* Protocol adapter reports malformed provider responses. */}
        return {status:result.status,json,headers:result.headers};
      },{...options,feedback:{signal:controller.signal,cancelled:()=>!current(),onRetry:(delay,retry)=>{this.requestStatus=`Provider rate limit. Retrying in ${Math.ceil(delay/1000)}s (${retry}/2)…`;if(current())this.render();}},onTool:(name,phase)=>{
        this.applying=phase==='start'&&['commit_changes','undo_operation'].includes(name);
        this.requestStatus=phase==='start'?`Running ${name}…`:'Waiting for assistant…';
        if(phase==='end')publishReceipts();else if(current())this.render();
      }});
      modelFinished=true;publishReceipts();
      if(!current())return;
      const changed=session.runtime.receipts.some(receipt=>receipt.status==='partial'||receipt.status==='committed'&&(receipt.changedFiles.length||receipt.stateChanges.length));
      if(reply.error&&!changed){this.draftText=message;userMessage.failed=true;}
      if(reply.text)this.messages.push({role:'assistant',content:reply.text});
      if(reply.error)this.messages.push({role:'assistant',content:reply.error,failed:true});
      if(!session.runtime.receipts.some(receipt=>receipt.changedFiles.length||receipt.status==='partial'))this.messages.push({role:'assistant',content:'Host result: No files changed in this turn.',failed:!!reply.error});
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
