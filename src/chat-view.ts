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
import { renderChatMarkdown } from './chat-markdown';
export const CHAT_VIEW = 'auto-scheduler-chat';
type ChatEntry = ChatMessage & { notes?: ScheduledNote[]; failed?: boolean; cancelled?:boolean; receipt?:OperationReceipt; internal?:boolean; sourcePath?:string };
export interface ChatConversation { id:string; messages:ChatEntry[]; draft:string }
function hasWrite(receipt:OperationReceipt):boolean {
  return receipt.status==='partial'||receipt.status==='committed'&&(receipt.changedFiles.length>0||receipt.stateChanges.length>0);
}
function visibleMessage(message:ChatEntry):boolean {
  return !message.internal && !(message.role==='assistant'&&message.content==='Host result: No files changed in this turn.')
    && !(message.receipt && /^(committed|noop|conflict|partial|failed):/.test(message.content));
}
function failureDetail(error:string):string {
  return error.split(/\r?\n/).find(line=>line.trim())?.trim()||'Unknown error';
}
export class ChatView extends ItemView {
  private messages: ChatEntry[] = [];
  private conversations: ChatConversation[];
  private conversationId: string;
  private pendingUser?: ChatEntry;
  private pendingReceipts:OperationReceipt[]=[];
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
      if(!this.applying&&!this.pendingReceipts.some(hasWrite)){
        this.pendingUser.failed=true;
        this.pendingUser.cancelled=true;
        this.draftText=this.pendingUser.content;
      }
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
    if(this.applying){new Notice('Wait for the current operation to finish');return;}
    this.cancelPending();this.messages=[];this.draftText='';this.saveConversation();this.render();
  }
  refresh(): void { this.render(); }
  private async loadModels(): Promise<void> {
    if (this.closed || this.modelBusy || !this.plugin.byok.providers.length) return;
    this.modelBusy = true; this.modelStatus = 'Loading provider models…'; this.render();
    try {
      await this.plugin.refreshModels(this.plugin.byok.activeProviderId);
      this.modelStatus = '';
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
      if(!visibleMessage(message))continue;
      const row = log.createDiv({ cls: `auto-scheduler-message auto-scheduler-${message.role}` });
      row.createDiv({ text: message.role === 'user' ? 'You' : 'Assistant', cls:'auto-scheduler-message-role' });
      const body=row.createDiv({cls:'auto-scheduler-message-content markdown-rendered'});
      try{renderChatMarkdown(this.app,message.content,body,message.sourcePath??this.app.workspace.getActiveFile()?.path??'');}
      catch{body.empty();body.createEl('p',{text:message.content,cls:'auto-scheduler-message-plain'});}
      if (message.failed && message.content.includes('HTTP 429') && new URL(this.plugin.state.llm.baseUrl).hostname === 'api.openai.com') {
        row.createEl('a', {text:'Open API limits', href:'https://platform.openai.com/settings/organization/limits', attr:{target:'_blank',rel:'noopener noreferrer'}});
      }
      const copy = row.createEl('button', { text: 'Copy', cls: 'auto-scheduler-message-copy', attr: { 'aria-label': 'Copy message' } });
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(message.content).then(() => { copy.textContent = 'Copied'; }, () => new Notice('Could not copy. Select the text and use your system copy shortcut.'));
      });
    }
    if (this.busy) log.createEl('p', { text: this.requestStatus || 'Working…',cls:'auto-scheduler-muted' });
    const composer = root.createDiv({ cls: 'auto-scheduler-composer' });
    const input = composer.createEl('textarea', { attr: { placeholder: 'Edit notes or ask to arrange time…', 'aria-label': 'Task conversation', rows: '3', maxlength: '12000' } });
    input.value = this.draftText; input.addEventListener('input', () => { this.draftText = input.value; this.saveConversation(); });
    input.disabled = this.busy;
    const actions = composer.createDiv({ cls: 'auto-scheduler-actions' });
    const send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' }); send.disabled = this.busy;
    send.addEventListener('click', () => { void this.send(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void this.send(input.value); } });
    const clear = actions.createEl('button', { text: 'Clear', attr: {'aria-label':'Clear conversation and cancel pending request','title':'Clear conversation and cancel pending request. Saved schedules remain.'} });
    clear.disabled=this.applying;
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
      const chinese=/\p{Script=Han}/u.test(message??this.messages.filter(entry=>entry.role==='user').slice(-1)[0]?.content??'');
      publish({role:'assistant',content:result.receipt?(chinese?'已撤销上次操作。':'Last operation undone.'):result.text,notes:result.notes,receipt:result.receipt,sourcePath:this.app.workspace.getActiveFile()?.path??''});
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
    const sourcePath=this.app.workspace.getActiveFile()?.path??'';
    const userMessage: ChatEntry = { role: 'user', content: message,sourcePath };
    this.draftText = ''; this.pendingUser=userMessage;this.pendingReceipts=[]; this.messages.push(userMessage); this.busy = true; this.render();
    const conversationId = this.conversationId;
    const chinese=/\p{Script=Han}/u.test(message);
    const say=(zh:string,en:string)=>chinese?zh:en;
    let receipts:OperationReceipt[]=[];
    const unresolvedProblem=()=>{
      let lastCommit=-1,lastFailure=-1;
      for(const [index,receipt] of receipts.entries()){
        if(receipt.status==='committed')lastCommit=index;
        if(['partial','failed','conflict'].includes(receipt.status))lastFailure=index;
      }
      return lastFailure>lastCommit?receipts[lastFailure]:undefined;
    };
    const publish=(entry:ChatEntry)=>{
      const messages=this.conversations.find(conversation=>conversation.id===conversationId)?.messages;
      messages?.push({...entry,sourcePath});
      if(!this.closed&&this.conversationId===conversationId)this.render();
    };
    const stopped=(error?:string)=>{
      // A stopped model request cannot undo a tool that already changed local state.
      const changed=receipts.some(hasWrite);
      const partial=receipts.some(receipt=>receipt.status==='partial')&&this.plugin.state.undo?.status==='partial';
      const problem=unresolvedProblem();
      if(partial||problem){
        const prefix=partial||problem?.status==='partial'?say('部分修改未完成，请先撤销上次操作。','Changes are incomplete. Undo the last operation before retrying.'):
          changed?say('部分操作已执行，后续操作失败。','Some operations ran; a later operation failed.'):say('操作未完成。','The operation did not complete.');
        const detail=problem?.warnings[0]||problem?.summary;
        return detail?`${prefix} ${failureDetail(detail)}`:prefix;
      }
      const prefix=changed?say('操作已执行，回复未完成。','The operation ran, but the reply did not finish.'):
        say('请求失败。','Request failed.');
      return error?`${prefix} ${failureDetail(error)}`:prefix;
    };
    try {
      const session=await this.plugin.agentSession(settingsKey,()=>!current());
      const options=agentSettings(this.plugin.state.agent);
      let reported=0;
      const publishReceipts=()=>{
        for(const receipt of session.runtime.receipts.slice(reported)){
          reported++;
          receipts.push(receipt);
          // Keep execution evidence for recovery without displaying it as assistant prose.
          publish({role:'assistant',content:receipt.summary,receipt,internal:true});
        }
        if(this.activeJob===job)this.pendingReceipts=receipts;
      };
      const reply=await runAgent(config,token,this.messages.filter(m=>visibleMessage(m)&&!m.cancelled).map(({role,content})=>({role,content})),session.instructions,session.runtime,async(url,headers,body)=>{
        const result=await requestUrl({url,method:'POST',headers,body,throw:false});let json:unknown={};
        try{json=result.json;}catch{/* Protocol adapter reports malformed provider responses. */}
        return {status:result.status,json,headers:result.headers};
      },{...options,feedback:{signal:controller.signal,cancelled:()=>!current(),onRetry:()=>{if(current()){this.requestStatus=say('稍后重试…','Retrying shortly…');this.render();}}},onTool:(name,phase)=>{
        if(this.activeJob===job){
          this.applying=phase==='start'&&['commit_changes','undo_operation'].includes(name);
          this.requestStatus=this.applying?say('保存中…','Saving…'):say('处理中…','Working…');
        }
        if(phase==='end')publishReceipts();
        if(current())this.render();
      }});
      publishReceipts();
      receipts=reply.receipts;
      if(!current()){
        if(receipts.some(hasWrite))publish({role:'assistant',content:stopped(),failed:this.plugin.state.undo?.status==='partial'});
        return;
      }
      const changed=receipts.some(hasWrite);
      if(reply.error&&!changed){this.draftText=message;userMessage.failed=true;}
      const problem=unresolvedProblem();
      if(problem||reply.error)publish({role:'assistant',content:stopped(reply.error),failed:!changed||this.plugin.state.undo?.status==='partial'});
      else if(reply.text)publish({role:'assistant',content:reply.text});
    } catch (error) {
      const changed=receipts.some(hasWrite);
      if(current()&&!changed){this.draftText=message;userMessage.failed=true;}
      if(current()||changed)publish({role:'assistant',content:stopped((error as Error).message),failed:!changed||this.plugin.state.undo?.status==='partial'});
    } finally {
      if (this.activeJob === job) { this.activeJob = null; this.pendingUser=undefined;this.pendingReceipts=[]; this.busy = false; this.applying = false; this.requestStatus = ''; if (this.requestAbort === controller) this.requestAbort = undefined; this.render(); }
    }
  }
}
