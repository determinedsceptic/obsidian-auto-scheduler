import { createAgentSession } from './plugin-agent';
import { agentSettings } from './agent-settings';
import type { AgentSession } from './plugin-agent';
import type { AgentSettings } from './types';
import { validUndoRecord } from './undo-record';
import { undoOperationId, NoteWorkspace } from './note-workspace';
import { copyDailyTasks } from './daily-copy';
import type { DailyCopy } from './daily-copy';
import { stageHabitFiles } from './habit-files';
import type { GuidelineDocument } from './habit-files';
import { readHabitIndex } from './habit-index';
import type { HabitIndexSnapshot } from './habit-index';
import { appendGuidelines } from './habit-guidelines';
import { deadlineLabel } from './calendar-format';
import { checkReadDate, readDailyPlan, previewDailyEdits } from './daily-edit';
import type { DailySnapshot, DailyEdit } from './daily-edit';
import { appendHabits, habitPath } from './habit-tool';
import { resolveEvents } from './event-tool';
import type { EventDraft } from './event-tool';
import type { HabitDraft } from './habit-tool';
import { parseHabits, HABIT_TEMPLATE, isHabit } from './habits';
import { Credentials } from './credentials';
import type { SecretPort } from './credentials';
import { ProviderModal } from './provider-modal';
import { activeConfig, migrateByok, validateByok, validateProvider, modelChoices, discoverModels } from './providers';
import { ChatView, CHAT_VIEW } from './chat-view';
import type { ChatConversation } from './chat-view';
import { materializeTasks, validAiTasks, endpoint } from './llm';
import { requestLlm } from './llm-request';
import { describeAiSchedule, planningDetails } from './ai-result';
import type { AiScheduleReply } from './ai-result';
import type { TaskDraft } from './llm';
import { rehydrate, validTracking } from './tracking';
import { cleanEventMetadata } from './event-tracking';
import { releaseEditedTracking } from './tracking-recovery';
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { applyPreview, createPreview, timezone, undoLast } from './transaction';
import type { Preview, VaultPort, StatePort } from './transaction';
import { DEFAULT_SETTINGS, DEFAULT_LLM } from './types';
import type { ByokSettings, ProviderConfig, PluginState, Settings, UndoRecord } from './types';
import { dateKey, addDays, clock, safeVaultPath } from './time';
import { OperationQueue } from './queue';
import { endClock } from './output';

class ObsidianVault implements VaultPort {
  constructor(private app: App) {}
  async listTasks(folder: string, excluded: string[]): Promise<string[]> {
    const path = normalizePath(folder);
    if (!this.app.vault.getAbstractFileByPath(path)) return [];
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw new Error(`Task folder is not a directory: ${path}. Configure a tasks folder first.`);
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(`${path}/`) && !excluded.includes(f.path)).map(f => f.path).sort();
  }
  async read(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`Path is not a file: ${path}`);
    return this.app.vault.read(file);
  }
  async writeChecked(path: string, expected: string | null, next: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (expected !== null) {
      if (!(file instanceof TFile)) throw new Error('Output was deleted or its type changed. Preview again.');
      await this.app.vault.process(file, current => {
        if (current !== expected) throw new Error('Output changed before writing; refusing to overwrite');
        return next;
      });
    } else {
      if (file) throw new Error('Output was created by another operation. Preview again.');
      const parts = path.split('/').slice(0, -1); let parent = '';
      for (const part of parts) {
        parent = parent ? `${parent}/${part}` : part;
        const entry = this.app.vault.getAbstractFileByPath(parent);
        if (!entry) await this.app.vault.createFolder(parent);
        else if (!(entry instanceof TFolder)) throw new Error(`Output parent is not a folder: ${parent}`);
      }
      // create refuses an existing file; do not fall back to modify.
      await this.app.vault.create(path, next);
    }
  }
}

function habitAnchorQuestion(items: string[]): string {
  const text=items.join(' ').toLowerCase();
  if (/(?:after )?(?:lunch|dinner)|午饭|午餐|晚饭|晚餐/.test(text)) return 'Relative-time items are not scheduled until their anchor times are confirmed. What time do lunch and dinner usually end, and which duration in the 10–20 minute rest range should I use?';
  return 'Relative-time items are not scheduled until their clock anchors are confirmed. What start times should I use for the listed actions?';
}
export default class AutoScheduler extends Plugin {
  state: PluginState = { settings: { ...DEFAULT_SETTINGS }, undo: null, tracking: {}, aiTasks: [], llm: { ...DEFAULT_LLM } };
  chatHistory:{activeId:string;sessions:ChatConversation[]}={activeId:crypto.randomUUID(),sessions:[]};
  credentials!: Credentials;
  get byok(): ByokSettings { return this.state.byok!; }
  get credentialMode(): string { return this.credentials.mode; }
  async getApiToken(): Promise<string> { activeConfig(this.byok); return this.credentials.get(this.byok.activeProviderId); }
  async checkApiConnection(): Promise<void> {
    try {
      endpoint(this.state.llm); // Validate the address before a credential-free GET.
      const url = this.state.llm.baseUrl.replace(/\/$/, '') + '/models';
      new Notice('Checking API connection without a token…');
      const reply = await requestLlm(url, {}, '', async () => {
        const result = await requestUrl({ url, method: 'GET', throw: false });
        return { status: 200, json: { httpStatus: result.status } };
      }, 15000);
      const status = (reply.json as { httpStatus: number }).httpStatus;
      new Notice(`API connection reached the server (HTTP ${status}). No token was sent; model access and quota were not tested.`, 15000);
    } catch (error) { new Notice(`API connection check failed: ${(error as Error).message}`, 15000); }
  }
  private operations = new OperationQueue();
  private vaultPort!: VaultPort;
  private storage: StatePort = {
    getUndo: () => this.state.undo,
    getTracking: () => this.state.tracking,
    getAiTasks: () => this.state.aiTasks,
    saveUndo: async (record, tracking, aiTasks) => {
      const previous = this.state.undo;
      const plan = (undo: UndoRecord) => JSON.stringify((undo.entries ?? [undo]).map(entry => [entry.path, entry.before, entry.after, entry.restored]));
      if (previous?.status === 'partial' && record && ((record.operationId ?? record.createdAt) !== (previous.operationId ?? previous.createdAt) || plan(record) !== plan(previous))) throw Error('A partial write must be undone before another commit');
      const next = { ...this.state, undo: record, aiTasks: aiTasks ?? this.state.aiTasks, tracking: tracking ?? this.state.tracking };
      await this.saveData(next); this.state = next;
    },
  };
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<PluginState> | null;
    this.state.settings = { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) };
    this.state.agent=agentSettings(saved?.agent);
    if (saved?.undo && validUndoRecord(saved.undo)) this.state.undo = saved.undo;
    else if (saved?.undo) new Notice('Invalid undo record; automatic recovery is disabled. Keep a backup of the plugin data.json.');
    if (saved?.tracking) {
      if (!validTracking(saved.tracking)) throw new Error('Invalid tracking data. Keep a backup of data.json.');
      this.state.tracking = saved.tracking;
    }
    this.state.llm = { protocol: saved?.llm?.protocol ?? DEFAULT_LLM.protocol, baseUrl: saved?.llm?.baseUrl ?? DEFAULT_LLM.baseUrl, model: saved?.llm?.model ?? DEFAULT_LLM.model };
    if (saved?.byok) { validateByok(saved.byok); this.state.byok = saved.byok; if (saved.byok.providers.length) this.state.llm = activeConfig(saved.byok); }
    else { this.state.byok = migrateByok(this.state.llm, crypto.randomUUID().replace(/-/g, '')); this.state.llm = activeConfig(this.state.byok); }
    const secretStorage = (this.app as App & { secretStorage?: SecretPort }).secretStorage;
    this.credentials = new Credentials(this.byok.namespace, secretStorage && typeof secretStorage.getSecret === 'function' && typeof secretStorage.setSecret === 'function' ? secretStorage : undefined);
    if (saved?.aiTasks) { if (!validAiTasks(saved.aiTasks)) throw new Error('Invalid AI task data. Keep a backup of data.json.'); this.state.aiTasks = saved.aiTasks; }
    if (!saved?.byok) await this.saveData(this.state);
    this.registerView(CHAT_VIEW, leaf => new ChatView(leaf, this));
    this.addCommand({ id: 'clear-chat', name: 'Clear AI conversation', callback: () => {
      for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW)) if (leaf.view instanceof ChatView) leaf.view.clearChat();
    } });
    this.addCommand({ id: 'check-api-connection', name: 'Check API connection (no token)', callback: () => { void this.checkApiConnection(); } });
    this.addCommand({ id: 'new-chat', name: 'Start new AI conversation', callback: () => { void this.action(async () => {
      await this.openChat();
      const leaf=this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
      if(leaf?.view instanceof ChatView)leaf.view.newChat();
    }); } });
    this.addCommand({ id: 'open-chat', name: 'Open AI assistant', callback: () => { void this.action(() => this.openChat()); } });
    this.vaultPort = new ObsidianVault(this.app);
    this.addSettingTab(new SchedulerSettings(this.app, this));
    this.addCommand({ id: 'create-habit-template', name: 'Create habits template', callback: () => { void this.action(async () => {
      if (!safeVaultPath(this.state.settings.habitFolder)) throw new Error('Configure a safe habits folder');
      const path = habitPath(this.state.settings);
      if (await this.vaultPort.read(path) === null) await this.vaultPort.writeChecked(path, null, HABIT_TEMPLATE);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(file);
    }); } });
    this.addCommand({ id: 'preview-week', name: 'Preview weekly schedule', callback: () => { void this.action(async () => {
      await this.recoverTrackingConflicts();
      const preview = await createPreview(this.vaultPort, this.state.settings, new Date(), this.state.tracking, false, this.state.aiTasks, [], {}, [], undefined, {preserveLayout:true});
      new PreviewModal(this.app, preview, this).open();
    }); } });
    this.addCommand({ id: 'clean-daily-output', name: 'Clean daily schedule format', callback: () => { void this.action(async () => {
      if (this.state.settings.outputLocation !== 'daily' || !this.state.settings.cleanDaily) throw new Error('Enable daily-note output and clean daily lists first');
      await this.recoverTrackingConflicts();
      const preview = await createPreview(this.vaultPort, this.state.settings, new Date(), this.state.tracking, true, this.state.aiTasks, [], {}, [], undefined, {preserveLayout:true});
      new PreviewModal(this.app, preview, this).open();
    }); } });
    this.addCommand({id:'clean-event-metadata',name:'Clean event display in current daily note',callback:()=>{void this.action(()=>this.cleanEventDisplay());}});
    this.addCommand({ id: 'recover-edited-daily', name: 'Clear optional schedule metadata in current daily note', callback: () => { void this.action(async () => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile)) throw Error('Open the edited daily note first');
      await this.recoverEditedDaily(file.path);
      new Notice('Optional schedule metadata cleared; note contents are unchanged. Use Undo last operation to restore it.', 15000);
    }); } });
    this.addCommand({ id: 'undo-last', name: 'Undo last operation', callback: () => { void this.action(async () => {
      await undoLast(this.vaultPort, this.storage, this.state.undo); this.refreshChats(); new Notice('Last operation undone');
    }); } });
    this.addRibbonIcon('calendar-clock', 'Open AI assistant', () => { void this.action(() => this.openChat()); });
  }
  onunload(): void { this.credentials?.clearSession(); }
  async openChat(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) { const right = this.app.workspace.getRightLeaf(false); if (!right) throw new Error('Could not open the sidebar'); leaf = right; await leaf.setViewState({ type: CHAT_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  refreshChats(): void { for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW)) if (leaf.view instanceof ChatView) leaf.view.refresh(); }
  private async cleanEventDisplay():Promise<void> {
    const file=this.app.workspace.getActiveFile(),settings=this.state.settings;
    if(!(file instanceof TFile)||!safeVaultPath(file.path)||!file.path.startsWith(settings.dailyFolder+'/')||!/^\d{4}-\d{2}-\d{2}\.md$/.test(file.path.slice(settings.dailyFolder.length+1)))throw Error('Open a dated note in the configured daily folder');
    const text=await this.vaultPort.read(file.path);
    if(text===null)throw Error('Daily note not found');
    const visible=cleanEventMetadata(file.path,text,settings.defaultEventDuration);
    if(visible.text===text){new Notice('Event display is already clean');return;}
    const annotated=rehydrate(text,this.state.tracking[file.path],file.path)!;
    const restored=cleanEventMetadata(file.path,annotated,settings.defaultEventDuration);
    const tracking=structuredClone(this.state.tracking);
    tracking[file.path]={...(tracking[file.path]??{before:null,after:null}),eventRecords:restored.eventRecords};
    if(!validTracking(tracking))throw Error('Event tracking is ambiguous; no note was changed');
    const workspace=new NoteWorkspace(this.vaultPort,this.storage,{files:[file.path],folders:[]});
    const staged=await workspace.stageExternalChanges({entries:[{path:file.path,before:text,after:visible.text}],dependencies:{[file.path]:text},state:{tracking},summary:'Clean event display while retaining its buffers'});
    const result=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    if(!result.ok)throw Error(result.error??'Event display cleanup did not complete');
    this.refreshChats();new Notice('Event display cleaned. Buffers are retained; use undo to restore the change.');
  }
  openProvider(existing?: ProviderConfig, done?: () => void): void { new ProviderModal(this, existing, done).open(); }
  async refreshModels(providerId: string): Promise<number> {
    return this.operations.run(async () => {
      const provider = this.byok.providers.find(p => p.id === providerId);
      if (!provider) throw new Error('Choose a provider first');
      const token = await this.credentials.get(providerId);
      const result = await discoverModels(provider, token, async (url, headers) => {
        const r = await requestUrl({url, method:'GET', headers, throw:false});
        return {status:r.status,json:r.status >= 200 && r.status < 300 ? r.json : {}};
      });
      const selected = this.byok.activeProviderId === providerId ? this.byok.activeModel : provider.models[0];
      const models = [...new Set([selected, ...result.models, ...provider.models])].slice(0, 1000);
      const byok = { ...this.byok, providers:this.byok.providers.map(p => p.id === providerId ? {...p,models} : p) };
      validateByok(byok);
      const next = { ...this.state, byok, llm:activeConfig(byok) };
      await this.saveData(next); this.state = next; this.refreshChats();
      return result.models.length;
    });
  }
  async selectModel(providerId: string, model: string): Promise<void> {
    await this.operations.run(async () => {
      const provider = this.byok.providers.find(p => p.id === providerId);
      if (!provider || !modelChoices(provider).includes(model)) throw new Error('Select an available model for this provider');
      const providers = this.byok.providers.map(p => p.id === providerId ? { ...p, models: [...new Set([...p.models, model])] } : p);
      const byok = { ...this.byok, providers, activeProviderId: providerId, activeModel: model }; validateByok(byok);
      const next = { ...this.state, byok, llm: activeConfig(byok) }; await this.saveData(next); this.state = next; this.refreshChats();
    });
  }
  async saveProvider(provider: ProviderConfig, token: string, selectedModel?: string): Promise<void> {
    await this.operations.run(async () => {
      validateProvider(provider);
      if (selectedModel !== undefined && !provider.models.includes(selectedModel)) throw new Error('Select a model saved under this provider');
      if (provider.requiresKey && !token.trim()) throw new Error('Enter an API key for this provider');
      const providers = this.byok.providers.filter(p => p.id !== provider.id); providers.push(provider);
      const byok = { ...this.byok, providers, activeProviderId: provider.id, activeModel: selectedModel ?? (this.byok.activeProviderId === provider.id && provider.models.includes(this.byok.activeModel) ? this.byok.activeModel : provider.models[0]) }; validateByok(byok);
      const previousKey = await this.credentials.get(provider.id);
      await this.credentials.set(provider.id, token.trim());
      const next = { ...this.state, byok, llm: activeConfig(byok) };
      try { await this.saveData(next); } catch {
        try { await this.credentials.set(provider.id, previousKey); } catch { throw new Error('Settings could not be saved and the key could not be restored. Check this provider in your device Keychain.'); }
        throw new Error('Settings could not be saved. The previous key was restored.');
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
      try { await this.saveData(next); } catch { await this.credentials.set(id, previousKey); throw new Error('Removal failed. The previous key was restored.'); }
      this.state = next; this.refreshChats();
    });
  }
  async undoSchedule(expectedUndoKey?: string): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (expectedUndoKey !== undefined && JSON.stringify(this.state.undo) !== expectedUndoKey) throw new Error('The last operation changed while processing your request. Request undo again.');
      const record = this.state.undo;
      const changedFiles:string[]=[];
      for(const entry of record?.entries??(record?[record]:[]))if(await this.vaultPort.read(entry.path)===entry.after)changedFiles.push(entry.path);
      await undoLast(this.vaultPort, this.storage, record);
      const paths = (record!.entries ?? [record!]).map(entry => entry.path);
      const notes = paths.filter(path => path.startsWith(this.state.settings.dailyFolder + '/') && /\/\d{4}-\d{2}-\d{2}\.md$/.test(path)).map(path => ({ path, date: path.slice(-13, -3) }));
      this.refreshChats();
      return { text: 'Last operation undone. Previous note contents and plugin state restored.', notes, receipt:{operationId:undoOperationId(record!),status:'committed',changedFiles,stateChanges:[...(record!.trackingAfterState&&JSON.stringify(record!.trackingAfterState)!==JSON.stringify(record!.trackingBeforeState)?['tracking']:[]),...(record!.aiTasksAfter&&JSON.stringify(record!.aiTasksAfter)!==JSON.stringify(record!.aiTasksBefore)?['aiTasks']:[])],warnings:[],undoAvailable:false,summary:'Last operation undone'} };
    });
  }
  async copyTasks(read:DailySnapshot,request:DailyCopy,expectedSettingsKey:string):Promise<AiScheduleReply>{
    return this.operations.run(async()=>{
      if(JSON.stringify(this.state.settings)!==expectedSettingsKey)throw Error('Scheduling settings changed. Request copy again.');
      const result=await copyDailyTasks(this.vaultPort,this.storage,this.state.settings,this.state.tracking,this.state.aiTasks,read,request,new Date());
      return {text:result.changed?`Copied ${result.count} Tasks rows to ${result.dates.length} dates. Source Tasks and Day planner are unchanged.`:'Identical Tasks rows already exist on the requested dates; no changes made.',notes:result.dates.map(date=>({date,path:`${this.state.settings.dailyFolder}/${date}.md`}))};
    });
  }
  async agentSession(expectedSettingsKey:string,cancelled?:()=>boolean):Promise<AgentSession>{
    const settings=structuredClone(this.state.settings),config=agentSettings(this.state.agent);
    const active=this.app.workspace.getActiveFile();
    return createAgentSession(this.vaultPort,this.storage,settings,{folders:config.noteFolders,files:active?[active.path]:[],dailyFolder:settings.dailyFolder},config.skillFiles,work=>this.operations.run(async()=>{
      if(cancelled?.())throw Error('Request cancelled before tool execution');
      if(JSON.stringify(this.state.settings)!==expectedSettingsKey||JSON.stringify(agentSettings(this.state.agent))!==JSON.stringify(config))throw Error('AI settings changed during this request. Send it again.');
      return work();
    }));
  }
  async updateAgentSettings(patch:Partial<AgentSettings>):Promise<void>{
    await this.action(async()=>{const next={...this.state,agent:agentSettings({...this.state.agent,...patch})};await this.saveData(next);this.state=next;this.refreshChats();});
  }
  async readPlan(date: string, expectedSettingsKey: string): Promise<DailySnapshot> {
    return this.operations.run(async () => {
      if (JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('Scheduling settings changed. Send your message again.');
      checkReadDate(date, new Date());
      await this.recoverTrackingConflicts();
      return readDailyPlan(this.vaultPort, this.state.settings, this.state.tracking, this.state.aiTasks, date, new Date());
    });
  }
  async readHabits(expectedSettingsKey:string):Promise<HabitIndexSnapshot>{
    return this.operations.run(async()=>{
      if(JSON.stringify(this.state.settings)!==expectedSettingsKey)throw Error('Scheduling settings changed. Send your message again.');
      return readHabitIndex(this.vaultPort,this.state.settings);
    });
  }
  async scheduleExistingHabits(read:HabitIndexSnapshot,expectedSettingsKey:string):Promise<AiScheduleReply>{
    return this.operations.run(async()=>{
      if(JSON.stringify(this.state.settings)!==expectedSettingsKey)throw Error('Scheduling settings changed. Send your message again.');
      const current=await readHabitIndex(this.vaultPort,this.state.settings);
      if(JSON.stringify(current.contents)!==JSON.stringify(read.contents))throw Error('Habit templates changed. Read them again.');
      if(!current.index.files.some(f=>f.habits.some(h=>h.enabled)))throw Error('No enabled fixed-time habits found. Read the action list and confirm its start times before scheduling.');
      const settings={...this.state.settings,outputLocation:'daily' as const,cleanDaily:true,balanceLoad:true,outputMode:this.state.settings.outputMode==='plain'?'day-planner' as const:this.state.settings.outputMode};
      await this.recoverTrackingConflicts();
      const now=new Date();const preview=await createPreview(this.vaultPort,settings,now,this.state.tracking,false,this.state.aiTasks);
      for(const [path,content] of Object.entries(read.contents))if(preview.snapshot[path]!==content)throw Error('Habit templates changed. Read them again.');
      if(JSON.stringify(Object.keys(preview.snapshot).filter(p=>p.startsWith(settings.habitFolder+'/')).sort())!==JSON.stringify(Object.keys(read.contents).sort()))throw Error('Habit templates changed. Read them again.');
      if(preview.result.errors.length)throw Error(preview.result.errors.map(e=>`${e.path}:${e.line}: ${e.message}`).join('\n'));
      const storage:StatePort={getUndo: this.storage.getUndo, getTracking: this.storage.getTracking,getAiTasks:this.storage.getAiTasks,saveUndo:async(undo,tracking,aiTasks)=>{const next={...this.state,settings,undo,tracking:tracking??this.state.tracking,aiTasks:aiTasks??this.state.aiTasks};await this.saveData(next);this.state=next;}};
      const applied=await applyPreview(this.vaultPort,storage,preview,settings,now);
      const today=dateKey(now),blocks=preview.result.blocks.filter(b=>isHabit(b.taskId)&&b.date>=today&&b.date<addDays(today,7));
      const notes=[...new Set(blocks.map(b=>b.date))].sort().map(date=>({date,path:`${settings.dailyFolder}/${date}.md`}));
      const lines=[applied.changed?'Existing habits saved to daily notes:':'Existing habits are already present in daily notes:'];
      for(const b of blocks)lines.push(`• ${b.date} ${clock(b.start)}–${endClock(b)}: ${b.title} (priority ${b.priority??3}/5)`);
      if(!blocks.length)lines.push('No occurrences fall within the next seven days. Check recurrence, enabled status and effective dates.');
      if(applied.warning)lines.push(applied.warning);
      return {text:lines.join('\n'),notes};
    });
  }
  async revisePlan(read: DailySnapshot, edits: DailyEdit[], expectedSettingsKey: string, guidelines: string[] = [], guidelineFiles:GuidelineDocument[]=[]): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('Scheduling settings changed. Send your message again.');
      const settings = { ...this.state.settings, outputLocation: 'daily' as const, cleanDaily: true, balanceLoad: true,
        outputMode: this.state.settings.outputMode === 'plain' ? 'day-planner' as const : this.state.settings.outputMode };
      const { preview, ids, defaults, unresolvedRules } = await previewDailyEdits(this.vaultPort, settings, this.state.tracking, this.state.aiTasks, read, edits, new Date(), crypto.randomUUID().replace(/-/g, ''), guidelines, guidelineFiles);
      if (preview.result.errors.length) throw new Error(preview.result.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
      let backupSaved = false;
      const storage: StatePort = { getUndo: this.storage.getUndo, getTracking: this.storage.getTracking, getAiTasks: this.storage.getAiTasks,
        saveUndo: async (undo,tracking,aiTasks) => {
          const next = { ...this.state, settings, undo, tracking:tracking ?? this.state.tracking, aiTasks:aiTasks ?? this.state.aiTasks };
          await this.saveData(next); this.state = next; backupSaved = true;
        } };
      try {
        const applied = await applyPreview(this.vaultPort, storage, preview, settings, new Date());
        const blocks = preview.result.blocks.filter(b => ids.has(b.taskId) && !b.completed);
        const lines = [...planningDetails(preview,ids), `Updated ${edits.length} unfinished tasks from ${read.read.date}. Completed records and recurring habits were preserved.`, 'Saved to daily notes:'];
        for (const b of blocks) lines.push(`• ${b.date} ${clock(b.start)}–${endClock(b)}: ${b.title} (priority ${b.priority ?? 3}/5)${preview.aiTasksAfter.find(t=>t.id===b.taskId)?.due === undefined ? '' : `; deadline ${deadlineLabel(preview.aiTasksAfter.find(t=>t.id===b.taskId)!.due!)}`}`);
        for (const t of preview.result.unscheduled.filter(t => ids.has(t.taskId))) lines.push(`Not yet scheduled: ${t.title}, ${t.remaining} min remaining. Saved for a later replan.`);
        if (guidelines.length) { lines.push(`Decomposed habit/action list saved in ${settings.habitFolder}. It is a template, not copied into daily schedule notes:`); const actions=guidelines.filter(item=>item.startsWith('ACTION: ')), rules=guidelines.filter(item=>item.startsWith('RULE: ')); if(actions.length){lines.push('Schedule actions:');for(const item of actions)lines.push(`• ${item.slice(8)}`);} if(rules.length){lines.push('Rules / conditions:');for(const item of rules)lines.push(`• ${item.slice(6)}`);} for(const item of guidelines.filter(item=>!item.startsWith('ACTION: ')&&!item.startsWith('RULE: ')))lines.push(`• ${item}`); if(unresolvedRules.length)lines.push(habitAnchorQuestion(unresolvedRules)); }
        if (defaults.length) lines.push(`Default duration (${settings.defaultEventDuration} min) used for: ${defaults.join(', ')}.`);
        if (applied.warning) lines.push(applied.warning);
        lines.push('Run Undo last schedule to restore the source and destination plans.');
        const notes = [...new Set(blocks.map(b => b.date))].sort().map(date => ({date,path:`${settings.dailyFolder}/${date}.md`}));
        return { text:lines.join('\n'), notes };
      } catch (error) {
        if (backupSaved) throw new Error(`Plan revision did not finish; a recovery backup is saved. Inspect the notes and run Undo last schedule. ${(error as Error).message}`);
        throw error;
      }
    });
  }

  async scheduleAi(drafts: TaskDraft[], expectedSettingsKey?: string): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (expectedSettingsKey !== undefined && JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('Scheduling settings changed. Send your message again.');
      if (this.state.aiTasks.length + drafts.length > 10000) throw new Error('AI task limit reached');
      const settings = { ...this.state.settings, outputLocation: 'daily' as const, cleanDaily: true, balanceLoad: true,
        outputMode: this.state.settings.outputMode === 'plain' ? 'day-planner' as const : this.state.settings.outputMode };
      await this.recoverTrackingConflicts();
      const added = materializeTasks(drafts, settings, new Date(), crypto.randomUUID().replace(/-/g, ''));
      const preview = await createPreview(this.vaultPort, settings, new Date(), this.state.tracking, false, this.state.aiTasks, added);
      if (preview.result.errors.length) throw new Error(preview.result.errors.map(e => `${e.path}${e.line ? ':' + e.line : ''}: ${e.message}`).join('\n'));
      const ids = new Set(added.map(t => t.id));
      if (!preview.result.blocks.some(b => ids.has(b.taskId))) throw new Error('No time is available for these new tasks in the next seven days. No new tasks were created. Adjust working hours, capacity, or deadlines and try again.');
      let backupSaved = false;
      const storage: StatePort = {
        getUndo: this.storage.getUndo, getTracking: this.storage.getTracking,
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
        if (backupSaved) throw new Error(`Scheduling did not finish; some daily notes may have been written. A recovery backup is saved. Inspect the notes and run Undo last schedule. ${(error as Error).message}`);
        throw error;
      }
    });
  }

  async scheduleHabits(drafts:HabitDraft[],expectedSettingsKey?:string):Promise<AiScheduleReply>{
    return this.schedulePlan([],drafts,[],expectedSettingsKey);
  }

  async schedulePlan(tasks: TaskDraft[], habits: HabitDraft[], drafts: EventDraft[], expectedSettingsKey?: string, guidelines: string[] = [], guidelineFiles:GuidelineDocument[]=[]): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (expectedSettingsKey !== undefined && JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('Scheduling settings changed. Send your message again.');
      if (this.state.aiTasks.length + tasks.length > 10000) throw new Error('AI task limit reached');
      const settings = { ...this.state.settings, outputLocation: 'daily' as const, cleanDaily: true, balanceLoad: true,
        outputMode: this.state.settings.outputMode === 'plain' ? 'day-planner' as const : this.state.settings.outputMode };
      await this.recoverTrackingConflicts();
      const now = new Date(), events = drafts.length ? resolveEvents(drafts, settings, now) : [];
      const added = tasks.length ? materializeTasks(tasks, settings, now, crypto.randomUUID().replace(/-/g, '')) : [];
      const staged=await stageHabitFiles(this.vaultPort,settings,habits,guidelines,guidelineFiles);
      const updates=staged.updates,createdHabits=staged.created;
      const preview = await createPreview(this.vaultPort, settings, now, this.state.tracking, false, this.state.aiTasks, added, updates, events);
      for(const [path,original] of Object.entries(staged.originals))if(preview.snapshot[path]!==original)throw Error('Habits template changed. Send your message again.');
      if (preview.result.errors.length) throw new Error(preview.result.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
      let backupSaved = false;
      const storage: StatePort = { getUndo: this.storage.getUndo, getTracking: this.storage.getTracking, getAiTasks: this.storage.getAiTasks,
        saveUndo: async (undo,tracking,aiTasks) => {
          const next = { ...this.state, settings, undo, tracking:tracking ?? this.state.tracking, aiTasks:aiTasks ?? this.state.aiTasks };
          await this.saveData(next); this.state = next; backupSaved = true;
        } };
      try {
        const applied = await applyPreview(this.vaultPort, storage, preview, settings, new Date());
        const ids = new Set(added.map(t => t.id));
        const blocks = preview.result.blocks.filter(b => ids.has(b.taskId) || [...createdHabits].some(id => b.taskId === `habit_${id}_${b.date.replace(/-/g, '')}`));
        const lines = [...planningDetails(preview,ids), 'Saved to daily notes:'];
        for (const e of events) lines.push(`• ${e.date} ${e.startTime}–${e.endTime}: ${e.title}${e.defaulted ? ` (default duration: ${settings.defaultEventDuration} min)` : ''}${e.dateDefaulted ? ' (default date: next occurrence of this time)' : ''}`);
        for (const b of blocks) lines.push(`• ${b.date} ${clock(b.start)}–${endClock(b)}: ${b.title} (priority ${b.priority ?? 3}/5)${preview.aiTasksAfter.find(t=>t.id===b.taskId)?.due === undefined ? '' : `; deadline ${deadlineLabel(preview.aiTasksAfter.find(t=>t.id===b.taskId)!.due!)}`}`);
        if (guidelines.length) { lines.push(`Decomposed habit/action list saved in ${Object.keys(updates).join(', ')}. It is not copied into daily schedule notes:`); const actions=guidelines.filter(item=>item.startsWith('ACTION: ')), rules=guidelines.filter(item=>item.startsWith('RULE: ')); if(actions.length){lines.push('Schedule actions:');for(const item of actions)lines.push(`• ${item.slice(8)}`);} if(rules.length){lines.push('Rules / conditions:');for(const item of rules)lines.push(`• ${item.slice(6)}`);} for(const item of guidelines.filter(item=>!item.startsWith('ACTION: ')&&!item.startsWith('RULE: ')))lines.push(`• ${item}`); if(staged.unresolvedRules.length)lines.push(habitAnchorQuestion(staged.unresolvedRules)); }
        if (habits.length) lines.push(`Recurring habits saved to ${Object.keys(updates).join(', ')}.`);
        for (const t of preview.result.unscheduled.filter(t => ids.has(t.taskId))) lines.push(`Not yet scheduled: ${t.title}, ${t.remaining} min remaining. Saved for a later replan.`);
        if (applied.warning) lines.push(applied.warning);
        lines.push('Run Undo last schedule to restore the entire operation.');
        const notes = [...new Set([...events.map(e => e.date), ...blocks.map(b => b.date), ])].sort().map(date => ({date,path:`${settings.dailyFolder}/${date}.md`}));
        return {text:lines.join('\n'),notes};
      } catch (error) {
        if (backupSaved) throw new Error(`Plan creation did not finish; a recovery backup is saved. Inspect the notes and run Undo last schedule. ${(error as Error).message}`);
        throw error;
      }
    });
  }

  async scheduleEvents(drafts: EventDraft[], expectedSettingsKey?: string): Promise<AiScheduleReply> {
    return this.operations.run(async () => {
      if (expectedSettingsKey !== undefined && JSON.stringify(this.state.settings) !== expectedSettingsKey) throw new Error('Scheduling settings changed. Send your message again.');
      const settings = { ...this.state.settings, outputLocation: 'daily' as const, cleanDaily: true, balanceLoad: true,
        outputMode: this.state.settings.outputMode === 'plain' ? 'day-planner' as const : this.state.settings.outputMode };
      await this.recoverTrackingConflicts();
      const now = new Date(), events = resolveEvents(drafts, settings, now);
      const preview = await createPreview(this.vaultPort, settings, now, this.state.tracking, false, this.state.aiTasks, [], {}, events);
      if (preview.result.errors.length) throw new Error(preview.result.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
      let backupSaved = false;
      const storage: StatePort = { getUndo: this.storage.getUndo, getTracking: this.storage.getTracking, getAiTasks: this.storage.getAiTasks,
        saveUndo: async (undo, tracking, aiTasks) => {
          const next = { ...this.state, settings, undo, tracking: tracking ?? this.state.tracking, aiTasks: aiTasks ?? this.state.aiTasks };
          await this.saveData(next); this.state = next; backupSaved = true;
        } };
      try {
        const applied = await applyPreview(this.vaultPort, storage, preview, settings, new Date());
        const lines = ['Fixed events saved to daily notes:'];
        for (const e of events) lines.push(`• ${e.date} ${e.startTime}–${e.endTime}: ${e.title}${e.defaulted ? ` (default duration: ${settings.defaultEventDuration} min)` : ''}${e.dateDefaulted ? ' (default date: next occurrence of this time)' : ''}`);
        if (preview.diff.removed.length) lines.push('Existing flexible work was replanned around these events.');
        if (preview.result.unscheduled.length) lines.push('Some ordinary tasks could not fit. Adjust capacity and replan later.');
        if (applied.warning) lines.push(applied.warning);
        lines.push('Run Undo last schedule to restore the previous notes.');
        const notes = [...new Set(events.map(e => e.date))].sort().map(date => ({ date, path: `${settings.dailyFolder}/${date}.md` }));
        return { text: lines.join('\n'), notes };
      } catch (error) {
        if (backupSaved) throw new Error(`Event creation did not finish; a recovery backup is saved. Inspect the notes and run Undo last schedule. ${(error as Error).message}`);
        throw error;
      }
    });
  }

  /** Compatibility hook: note edits no longer need a separate recovery operation. */
  async recoverTrackingConflicts(): Promise<string[]> {
    return [];
  }

  async recoverEditedDaily(path: string): Promise<string> {
    if (this.state.undo?.status === 'partial') throw Error('A partial write must be undone before tracking recovery or another commit');
    const text = await this.vaultPort.read(path);
    if (text === null) throw Error('Daily note not found');
    const nextTracking = releaseEditedTracking(path, text, this.state.tracking, this.state.settings);
    const workspace=new NoteWorkspace(this.vaultPort,this.storage,{files:[path],folders:[]});
    const staged=await workspace.stageExternalChanges({entries:[],dependencies:{[path]:text},state:{tracking:nextTracking},summary:'Clear optional schedule metadata without editing the note'});
    const committed=await workspace.execute('commit_changes',{changeSetRef:staged.changeSetRef});
    if(!committed.ok)throw Error(committed.error??'Metadata reset did not commit');
    this.refreshChats();
    return committed.receipt!.operationId;
  }

  async openScheduledNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Daily note not found: ${path}`);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async action(work: () => Promise<void>): Promise<void> {
    // Serialize all writes, including rapid settings edits. Never discard keystrokes.
    await this.operations.run(work).catch(error => {
      new Notice(`Auto Scheduler: ${(error as Error).message}`, 12000);
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
        if (JSON.stringify(this.state.settings) !== originalSettingsKey) throw new Error('Settings changed. Generate a new preview.');
        const next = { ...this.state, settings: preview.settings }; await this.saveData(next); this.state = next;
      }
      const result = await applyPreview(this.vaultPort, this.storage, preview, this.state.settings);
      new Notice(result.warning ?? (result.changed ? 'Schedule saved. Use the undo command to restore it.' : 'Schedule unchanged; nothing to write'), result.warning ? 12000 : 5000);
      done();
    });
  }
}
class PreviewModal extends Modal {
  constructor(app: App, private preview: Preview, private plugin: AutoScheduler, private applied?: () => void, private originalSettingsKey?: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('auto-scheduler-modal');
    const { contentEl } = this; const { result, settings, diff } = this.preview;
    contentEl.createEl('h2', { text: 'Weekly schedule preview' });
    contentEl.createEl('p', { text: `${this.preview.today} onward · ${this.preview.timezone} · Output: ${settings.outputLocation === 'daily' ? settings.dailyFolder + '/YYYY-MM-DD.md' : settings.outputFile}` });
    contentEl.createEl('p', { text: 'Unlocked blocks in this week are replaced. In metadata mode, set locked=true to retain a manual position. Clean lists support completion checkboxes; undo before editing generated times or titles. Maintain remaining minutes for handwritten tasks; AI tasks account for completed blocks automatically.' });
    const creating = this.preview.aiTasksAfter.filter(t => !this.preview.aiTasksBefore.some(old => old.id === t.id));
    if (creating.length) {
      contentEl.createEl('h3', { text: 'New AI tasks' });
      for (const t of creating) contentEl.createEl('p', { text: `${t.title} · ${t.remaining} min · Priority ${t.priority} · ${t.split ? 'Splittable' : 'Continuous'} · Minimum block ${t.min} min` });
    }
    if (this.preview.snapshot[settings.fixedFile] === null) contentEl.createEl('p', { text: `Fixed-events file not found: ${settings.fixedFile}. No events from this file were used. Check your availability.`, cls: 'auto-scheduler-warning' });
    if (result.errors.length) {
      contentEl.createEl('h3', { text: 'Inputs to fix' }); const list = contentEl.createEl('ul');
      for (const error of result.errors) list.createEl('li', { text: `${error.path}${error.line ? `:${error.line}` : ''}: ${error.message}` });
    }
    contentEl.createEl('p', { text: `Added ${diff.added.length} · Removed ${diff.removed.length} · Retained ${diff.retained.length}` });
    if (diff.removed.length) {
      const detail = contentEl.createEl('details'); detail.createEl('summary', { text: 'Blocks to remove' });
      for (const b of diff.removed) detail.createEl('p', { text: `${b.date} ${clock(b.start)}–${endClock(b)} · ${b.taskId}` });
    }
    for (const day of result.days) {
      contentEl.createEl('h3', { text: `${day.date} · Occupied ${day.occupied}/${day.capacity} min${day.overCapacity ? '(existing events exceed capacity; no new work today)' : ''}` });
      const list = contentEl.createEl('ul');
      const blocks = result.blocks.filter(b => b.date === day.date);
      if (!blocks.length) list.createEl('li', { text: 'No time blocks' });
      for (const block of blocks) {
        const item = list.createEl('li');
        item.createSpan({ text: `${clock(block.start)}–${endClock(block)} ${block.completed ? ' · Completed' : block.locked ? ' · Fixed' : ''} ` });
        if (this.preview.aiTasksAfter.some(t => t.id === block.taskId)) { item.createSpan({ text: block.title }); continue; }
        const source = item.createEl('a', { text: block.title, href: '#' });
        source.addEventListener('click', event => { event.preventDefault(); void this.app.workspace.openLinkText(block.path, '', true); });
      }
    }
    if (result.unscheduled.length) {
      contentEl.createEl('h3', { text: 'Not yet scheduled' }); const list = contentEl.createEl('ul');
      for (const task of result.unscheduled) list.createEl('li', { text: `${task.taskId} · Remaining ${task.remaining} min · ${task.reason}` });
    }
    if (this.preview.output !== null) {
      const detail = contentEl.createEl('details'); detail.createEl('summary', { text: 'View exact file changes' });
      detail.createEl('pre', { text: this.preview.output });
    }
    const actions = contentEl.createDiv({ cls: 'auto-scheduler-actions' });
    const apply = actions.createEl('button', { text: 'Apply schedule', cls: 'mod-cta' });
    apply.disabled = result.errors.length > 0 || this.preview.output === null;
    apply.addEventListener('click', () => {
      apply.disabled = true;
      void this.plugin.apply(this.preview, () => { this.close(); this.applied?.(); }, this.originalSettingsKey).finally(() => { apply.disabled = result.errors.length > 0 || this.preview.output === null; });
    });
    const cancel = actions.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}
class SchedulerSettings extends PluginSettingTab {
  constructor(app: App, private plugin: AutoScheduler) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    const settings = this.plugin.state.settings;
    // The host already displays the plugin name in the settings pane.
    containerEl.createEl('p', { text: `Local time zone: ${timezone()}. Manual commands preview before writing. AI tool results show actual committed changes; ordinary editing does not run the scheduler. Handwritten daily time ranges count as occupied time.` });
    const text = (name: string, description: string, value: string, update: (value: string) => Partial<Settings>): void => {
      new Setting(containerEl).setName(name).setDesc(description).addText(input => input.setValue(value).onChange(value => { void this.plugin.updateSettings(update(value.trim())); }));
    };
    containerEl.createEl('h3', { text: 'Providers and models (BYOK)' });
    containerEl.createEl('p', { text: `API key storage: ${this.plugin.credentialMode}. Cancel discards changes; keys are not written to data.json or notes.` });
    new Setting(containerEl).setName('Add provider').setDesc('Choose a template, enter your key, and select or enter model IDs.').addButton(b => b.setButtonText('Add provider').onClick(() => this.plugin.openProvider(undefined, () => this.display())));
    if (this.plugin.byok.providers.length) new Setting(containerEl).setName('Chat model').addDropdown(input => {
      for (const provider of this.plugin.byok.providers) for (const model of modelChoices(provider)) input.addOption(JSON.stringify([provider.id, model]), `${provider.name} / ${model}`);
      input.setValue(JSON.stringify([this.plugin.byok.activeProviderId, this.plugin.byok.activeModel])).onChange(value => {
        const [id, model] = JSON.parse(value); void this.plugin.selectModel(id, model).catch(error => new Notice((error as Error).message));
      });
    });
    for (const provider of this.plugin.byok.providers) {
      new Setting(containerEl).setName(provider.name).setDesc(`${provider.protocol} · ${provider.baseUrl} · ${provider.requiresKey ? 'Key required' : 'Key optional'} · ${provider.models.join(', ')}`)
        .addButton(b => b.setButtonText('Edit').onClick(() => this.plugin.openProvider(provider, () => this.display())))
        .addButton(b => b.setButtonText('Remove').onClick(() => {
          const modal = new Modal(this.app); modal.contentEl.createEl('h3', { text: `Remove ${provider.name}?` });
          modal.contentEl.createEl('p', { text: 'Remove this provider, its models, and the key stored by this plugin. Existing tasks and notes are preserved.' });
          modal.contentEl.createEl('button', { text: 'Confirm removal' }).addEventListener('click', () => { void this.plugin.removeProvider(provider.id).then(() => { modal.close(); this.display(); }).catch(error => new Notice((error as Error).message)); });
          modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close()); modal.open();
        }));
    }
    containerEl.createEl('h3',{text:'AI note access and skills'});
    containerEl.createEl('p',{text:'AI can access the current note and dated notes in the daily folder. Additional folders below expand that scope. Ordinary note edits preserve their headings; scheduling writes Day planner only.'});
    const agent=agentSettings(this.plugin.state.agent);
    new Setting(containerEl).setName('Additional note folders').setDesc('One vault-relative folder per line. Empty grants no additional folder access.').addTextArea(input=>input.setValue(agent.noteFolders.join('\n')).onChange(value=>{void this.plugin.updateAgentSettings({noteFolders:value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean)});}));
    new Setting(containerEl).setName('Runtime skill files').setDesc('Optional Markdown paths, one per line. These replace the bundled default instructions and are reloaded on each send. No rebuild required.').addTextArea(input=>input.setValue(agent.skillFiles.join('\n')).onChange(value=>{void this.plugin.updateAgentSettings({skillFiles:value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean)});}));
    new Setting(containerEl).setName('Tool round budget').setDesc('Maximum model turns per request.').addText(input=>input.setValue(String(agent.maxSteps)).onChange(value=>{const maxSteps=Number(value);if(Number.isInteger(maxSteps)&&maxSteps>=2&&maxSteps<=128)void this.plugin.updateAgentSettings({maxSteps});}));
    new Setting(containerEl).setName('Context budget (characters)').setDesc('Maximum combined request context.').addText(input=>input.setValue(String(agent.maxContextChars)).onChange(value=>{const maxContextChars=Number(value);if(Number.isInteger(maxContextChars)&&maxContextChars>=20000&&maxContextChars<=1000000)void this.plugin.updateAgentSettings({maxContextChars});}));
    new Setting(containerEl).setName('Request time budget (seconds)').setDesc('Stops further model and tool work when this budget expires. A started commit finishes safely.').addText(input=>input.setValue(String(agent.timeoutMs/1000)).onChange(value=>{const timeoutMs=Number(value)*1000;if(Number.isInteger(timeoutMs)&&timeoutMs>=15000&&timeoutMs<=600000)void this.plugin.updateAgentSettings({timeoutMs});}));
    text('Tasks folder', 'Vault-relative folder; scans Markdown files within it', settings.taskFolder, taskFolder => ({ taskFolder }));
    text('Habits folder', 'Read Markdown templates here before scheduling; use Create habits template for examples', settings.habitFolder, habitFolder => ({ habitFolder }));
    text('Fixed-events file', 'Format: - YYYY-MM-DD HH:mm-HH:mm Title. A missing file means no fixed events.', settings.fixedFile, fixedFile => ({ fixedFile }));
    text('Schedule file', 'Dedicated Markdown output; ordinary existing notes are not taken over', settings.outputFile, outputFile => ({ outputFile }));
    new Setting(containerEl).setName('Output location').addDropdown(input => input.addOption('single', 'Single schedule file').addOption('daily', 'Daily notes: Day planner').setValue(settings.outputLocation).onChange(value => { void this.plugin.updateSettings({ outputLocation: value as Settings['outputLocation'] }); }));
    new Setting(containerEl).setName('Clean daily lists').setDesc('Write plain time-based tasks to daily notes; tracking stays in plugin data. Turn off for full Gantt date fields.').addToggle(input => input.setValue(settings.cleanDaily).onChange(cleanDaily => { void this.plugin.updateSettings({ cleanDaily }); }));
    text('Daily notes folder', 'YYYY-MM-DD.md; preserve handwritten content and other sections', settings.dailyFolder, dailyFolder => ({ dailyFolder }));
    text('Gantt task prefix', 'Match Gantt Calendar task filter, default 🎯. Can be empty.', settings.ganttFilter, ganttFilter => ({ ganttFilter }));
    text('Working days', 'Comma-separated: 0 is Sunday, 1 is Monday, …, 6 is Saturday', Array.isArray(settings.weekdays) ? settings.weekdays.join(',') : String(settings.weekdays), value => ({ weekdays: value.split(',').map(v => v.trim() ? Number(v.trim()) : NaN) }));
    text('Working hours', 'Comma-separated, e.g. 09:00-12:00,14:00-18:00; 15-minute grid', Array.isArray(settings.periods) ? settings.periods.join(',') : String(settings.periods), value => ({ periods: value.split(',').map(v => v.trim()) }));
    for (const [field, name, description] of [
      ['dailyCapacity', 'Daily capacity (minutes)', 'Includes events, time blocks, and buffers within working hours'],
      ['fixedBuffer', 'Buffer around fixed events', 'Minutes, in multiples of 15; 0 is allowed'],
      ['blockBuffer', 'Buffer after time blocks', 'Minutes, in multiples of 15; 0 is allowed'],
      ['defaultEventDuration', 'Default duration (minutes)', 'For tasks, events and habits without a duration; 15–1440 minutes in multiples of 15'],
    ] as const) text(name, description, String(settings[field]), value => ({ [field]: value ? Number(value) : NaN }));
    new Setting(containerEl).setName('Output format').setDesc('Gantt uses full start/scheduled/due dates. Choose Day Planner or Gantt for daily notes.').addDropdown(input => input.addOption('plain', 'Plain Markdown list').addOption('day-planner', 'Day Planner').addOption('gantt', 'Gantt Calendar（Dataview）').setValue(settings.outputMode).onChange(value => { void this.plugin.updateSettings({ outputMode: value as Settings['outputMode'] }); }));
    containerEl.createEl('p', { text: 'Metadata mode requires complete as-block fields; use locked=true to preserve a position. Clean lists keep tracking in plugin data. Preview again after changing settings.' });
  }
}
