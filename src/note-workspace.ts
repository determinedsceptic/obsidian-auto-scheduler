import type { AgentRuntime, AgentScope, ExternalChanges, OperationReceipt, ToolDefinition, ToolResult } from './agent-types';
import { undoLast } from './transaction';
import type { StatePort, VaultPort } from './transaction';
import type { FileChange, Task, Tracking, UndoRecord } from './types';
import { safeVaultPath } from './time';
import { normalizeMarkdownNewlines, parseMarkdownStructure } from './markdown-structure';

export type NoteReferenceKind = 'document' | 'section' | 'block';
export interface ResolvedNoteReference { path:string;before:string|null;documentText:string;start:number;end:number;kind:NoteReferenceKind;text:string;changeSetRef?:string }
interface StoredRef { kind:NoteReferenceKind; path:string; before:string|null; documentText:string; start:number; end:number; text:string; read:boolean; documentRef:string; versionRef:string; staged?:string }
interface StagedChangeSet {
  entries:FileChange[]; dependencies:Record<string,string|null>; stateBefore:{tracking?:Tracking;aiTasks?:Task[]}; stateAfter:{tracking?:Tracking;aiTasks?:Task[]};
  summary:string; displayChanges:unknown; trusted:boolean; validate?:()=>void|Promise<void>;
}
interface EditInput { operation:'insert'|'replace'|'delete'; targetRef:string; position?:'before'|'after'|'append'|'end'; content?:string }

const objectSchema = (properties:Record<string,unknown>, required:string[] = []):Record<string,unknown> => ({ type:'object', additionalProperties:false, properties, ...(required.length ? {required} : {}) });
const stringArray = {type:'array',items:{type:'string'},minItems:1};

export const NOTE_WORKSPACE_TOOLS:ToolDefinition[] = [
  {name:'discover_notes',description:'Find Markdown notes inside the authorized scope. Explicit missing paths and dates return creatable document references.',strict:true,parameters:{...objectSchema({paths:stringArray,query:{type:'string',minLength:1},dates:{...stringArray,items:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}}}),anyOf:[{required:['paths']},{required:['query']},{required:['dates']}]}},
  {name:'read_note',description:'Read an outline, full document, section, or block from a discovered note. The default outline omits bodies. Pass changeSetRef to read the exact staged overlay.',strict:true,parameters:objectSchema({documentRef:{type:'string'},mode:{type:'string',enum:['outline','document','section','block']},ref:{type:'string'},changeSetRef:{type:['string','null']}},['documentRef'])},
  {name:'stage_note_changes',description:'Stage insertions, replacements, or deletions against references from read_note. A discovered missing document reference may only be inserted to create that note.',strict:true,parameters:objectSchema({changes:{type:'array',minItems:1,items:objectSchema({operation:{type:'string',enum:['insert','replace','delete']},targetRef:{type:'string'},position:{type:'string',enum:['before','after','append','end']},content:{type:'string'}},['operation','targetRef'])},summary:{type:'string'}},['changes'])},
  {name:'commit_changes',description:'Commit a staged change set after scope, note-version, and state-version checks.',strict:true,parameters:objectSchema({changeSetRef:{type:'string'}},['changeSetRef'])},
  {name:'undo_operation',description:'Undo the identified durable operation if its files and state are unchanged.',strict:true,parameters:objectSchema({operationId:{type:'string'}},['operationId'])},
];

function clone<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
function diffStats(before:string,after:string):{addedLines:number;removedLines:number} {
  const oldLines=before?before.split(/\r\n|\r|\n/):[],newLines=after?after.split(/\r\n|\r|\n/):[];
  let prefix=0;while(prefix<oldLines.length&&prefix<newLines.length&&oldLines[prefix]===newLines[prefix])prefix++;
  let suffix=0;while(suffix<oldLines.length-prefix&&suffix<newLines.length-prefix&&oldLines[oldLines.length-1-suffix]===newLines[newLines.length-1-suffix])suffix++;
  return {addedLines:newLines.length-prefix-suffix,removedLines:oldLines.length-prefix-suffix};
}
function validDate(value:string):boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day] = value.split('-').map(Number), date = new Date(year,month-1,day);
  return date.getFullYear() === year && date.getMonth() === month-1 && date.getDate() === day;
}
function stateUndo(state:StatePort):UndoRecord|null {
  const extended=state as StatePort&{getUndo?:()=>UndoRecord|null;undo?:UndoRecord|null};
  return extended.getUndo?.() ?? extended.undo ?? null;
}
export function undoOperationId(record:UndoRecord):string { return record.operationId ?? `legacy_${record.createdAt.replace(/[^0-9A-Za-z]/g,'')}`; }

export class NoteWorkspace implements AgentRuntime {
  readonly tools:ToolDefinition[] = NOTE_WORKSPACE_TOOLS;
  readonly receipts:OperationReceipt[] = [];
  private refs=new Map<string,StoredRef>(); private stages=new Map<string,StagedChangeSet>(); private dependencies=new Map<string,string|null>();
  private serial=0; private currentUndo:UndoRecord|null; private recoveryRequired:boolean;
  private readonly now:()=>Date; private readonly validateEdit?: (path:string,before:string|null,after:string)=>void|Promise<void>;
  private readonly prepareChanges?: (changes:ExternalChanges,phase:'stage'|'commit',context:{trusted:boolean})=>Promise<ExternalChanges>|ExternalChanges;
  constructor(private readonly vault:VaultPort,private readonly state:StatePort,private readonly scope:AgentScope,options:{now?:()=>Date;validateEdit?:(path:string,before:string|null,after:string)=>void|Promise<void>;prepareChanges?:(changes:ExternalChanges,phase:'stage'|'commit',context:{trusted:boolean})=>Promise<ExternalChanges>|ExternalChanges}={}) {
    this.now=options.now??(()=>new Date()); this.validateEdit=options.validateEdit; this.prepareChanges=options.prepareChanges; this.currentUndo=stateUndo(state); this.recoveryRequired=this.currentUndo?.status==='partial';
  }

  resolveReference(ref:string):ResolvedNoteReference {
    const value=this.refs.get(ref); if(!value||!value.read)throw new Error('Reference was not returned by read_note');
    return {path:value.path,before:value.before,documentText:value.documentText,start:value.start,end:value.end,kind:value.kind,text:value.text,...(value.staged?{changeSetRef:value.staged}:{})};
  }
  getReadDependencies():Record<string,string|null>{return Object.fromEntries(this.dependencies);}
  getStagedChanges(changeSetRef:string):ExternalChanges {
    if(this.recoveryRequired||stateUndo(this.state)?.status==='partial')throw new Error('A partial operation must be undone before composing staged changes');
    const stage=this.stages.get(changeSetRef);if(!stage)throw new Error('Unknown change set reference');
    if(!this.stateMatches(stage))throw new Error('Plugin state changed after staging');
    const state:ExternalChanges['state']={};if(stage.stateAfter.tracking!==undefined)state.tracking=clone(stage.stateAfter.tracking);if(stage.stateAfter.aiTasks!==undefined)state.aiTasks=clone(stage.stateAfter.aiTasks);
    return {entries:clone(stage.entries),dependencies:clone(stage.dependencies),...(state.tracking!==undefined||state.aiTasks!==undefined?{state}:{}),summary:stage.summary,...(stage.validate?{validate:stage.validate}:{})};
  }

  async execute(name:string,args:unknown):Promise<ToolResult>{
    try {
      if(name==='discover_notes')return {ok:true,value:await this.discover(args)};
      if(name==='read_note')return {ok:true,value:await this.read(args)};
      if(name==='stage_note_changes')return {ok:true,value:await this.stage(args)};
      if(name==='commit_changes')return await this.commit(args);
      if(name==='undo_operation')return await this.undo(args);
      throw new Error(`Unknown tool: ${name}`);
    }catch(error){return {ok:false,error:(error as Error).message};}
  }

  async stageExternalChanges(changes:ExternalChanges):Promise<{changeSetRef:string;summary:string;changes:unknown}>{
    if(!changes||!Array.isArray(changes.entries))throw new Error('External changes require an entries array');
    const hasState=changes.state?.tracking!==undefined||changes.state?.aiTasks!==undefined;
    if(!changes.entries.length&&!hasState)throw new Error('External changes require a file or state change');
    const initial={...changes,summary:changes.summary||`Stage ${changes.entries.length} external note change(s)`};
    const prepared=await this.prepare(initial,true,'stage',changes.validate);
    const dependencies=this.mergeDependencies(prepared.dependencies,prepared.entries);
    return this.storeStage(prepared.entries,dependencies,prepared.state??{},prepared.summary,true,prepared.validate);
  }

  private ref(prefix:string):string{return `${prefix}_${(++this.serial).toString(36)}`;}
  private version():string{return this.ref('version');}
  private allowed(path:string):boolean {
    if(!safeVaultPath(path)||!path.endsWith('.md'))return false;
    if(this.scope.files.some(file=>file===path))return true;
    if(this.scope.folders.some(folder=>safeVaultPath(folder)&&(path.startsWith(folder+'/'))))return true;
    if(!this.scope.dailyFolder||!safeVaultPath(this.scope.dailyFolder)||!path.startsWith(this.scope.dailyFolder+'/'))return false;
    const name=path.slice(this.scope.dailyFolder.length+1);return /^\d{4}-\d{2}-\d{2}\.md$/.test(name)&&validDate(name.slice(0,-3));
  }
  private args(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Tool arguments must be an object');return value as Record<string,unknown>;}
  private onlyKeys(value:Record<string,unknown>,allowed:string[]):void{const extra=Object.keys(value).filter(key=>!allowed.includes(key));if(extra.length)throw new Error(`Unknown tool argument: ${extra.join(', ')}`);}
  private normalizeChanges(changes:ExternalChanges,trusted:boolean,preserveValidate?:()=>void|Promise<void>):ExternalChanges {
    if(!changes||typeof changes!=='object'||!Array.isArray(changes.entries))throw new Error('Prepared changes require an entries array');
    if(!changes.dependencies||typeof changes.dependencies!=='object'||Array.isArray(changes.dependencies))throw new Error('Prepared changes require dependencies');
    if(typeof changes.summary!=='string')throw new Error('Prepared changes require a summary');
    const seen=new Set<string>();
    for(const entry of changes.entries){
      if(!entry||typeof entry.path!=='string'||typeof entry.after!=='string'||(entry.before!==null&&typeof entry.before!=='string'))throw new Error('Invalid prepared file change');
      if(!this.allowed(entry.path)||seen.has(entry.path))throw new Error(`Prepared change is outside scope or duplicated: ${entry.path}`);seen.add(entry.path);
    }
    // Trusted adapters may depend on scheduler inputs outside the model-visible
    // note scope. Those bytes are checked at commit but never returned to tools.
    for(const [path,before] of Object.entries(changes.dependencies)){if(!safeVaultPath(path)||(!trusted&&!this.allowed(path))||(before!==null&&typeof before!=='string'))throw new Error(`Invalid prepared dependency: ${path}`);}
    const validate=preserveValidate??changes.validate;if(validate!==undefined&&typeof validate!=='function')throw new Error('External validate must be a function');
    const state=changes.state?clone(changes.state):undefined;
    return {entries:clone(changes.entries).filter(entry=>entry.before!==entry.after),dependencies:clone(changes.dependencies),...(state?{state}:{}),summary:changes.summary,...(validate?{validate}:{})};
  }
  private async prepare(changes:ExternalChanges,trusted:boolean,phase:'stage'|'commit',preserveValidate?:()=>void|Promise<void>):Promise<ExternalChanges> {
    const normalized=this.normalizeChanges(changes,trusted,preserveValidate);
    if(!this.prepareChanges)return normalized;
    const prepared=await this.prepareChanges({entries:clone(normalized.entries),dependencies:clone(normalized.dependencies),...(normalized.state?{state:clone(normalized.state)}:{}),summary:normalized.summary,...(normalized.validate?{validate:normalized.validate}:{})},phase,{trusted});
    return this.normalizeChanges(prepared,trusted,preserveValidate??normalized.validate);
  }
  private mergeDependencies(dependencies:Record<string,string|null>,entries:FileChange[],fixed:Record<string,string|null>={}):Record<string,string|null> {
    const merged={...dependencies};
    for(const [path,before] of Object.entries(fixed)){
      if(Object.prototype.hasOwnProperty.call(merged,path)&&merged[path]!==before)throw new Error(`Prepared changes cannot rebase an existing dependency: ${path}`);
      merged[path]=before;
    }
    for(const entry of entries){
      if(Object.prototype.hasOwnProperty.call(merged,entry.path)&&merged[entry.path]!==entry.before)throw new Error(`Prepared file baseline does not match its dependency: ${entry.path}`);
      merged[entry.path]=entry.before;
    }
    return merged;
  }
  private document(path:string,before:string|null,read=false):{documentRef:string;versionRef:string} {
    const documentRef=this.ref('document'),versionRef=this.version(),text=before??'';
    this.refs.set(documentRef,{kind:'document',path,before,documentText:text,start:0,end:text.length,text,read,documentRef,versionRef}); return {documentRef,versionRef};
  }
  private async discover(input:unknown):Promise<unknown>{
    const args=this.args(input),paths=args.paths,dates=args.dates,query=args.query;
    this.onlyKeys(args,['paths','dates','query']);
    if(paths!==undefined&&(!Array.isArray(paths)||!paths.length||paths.some(p=>typeof p!=='string')))throw new Error('paths must be a non-empty array of strings');
    if(dates!==undefined&&(!Array.isArray(dates)||!dates.length||dates.some(d=>typeof d!=='string'||!validDate(d))))throw new Error('dates must contain valid YYYY-MM-DD dates');
    if(query!==undefined&&(typeof query!=='string'||!query.trim()))throw new Error('query must be a non-empty string');
    if(paths===undefined&&dates===undefined&&query===undefined)throw new Error('Provide paths, dates, or query');
    const requested=new Set<string>();
    for(const path of (paths as string[]|undefined)??[]){if(!this.allowed(path))throw new Error(`Path is outside the authorized scope: ${path}`);requested.add(path);}
    if(dates){if(!this.scope.dailyFolder)throw new Error('No daily folder is authorized');for(const date of dates as string[])requested.add(`${this.scope.dailyFolder}/${date}.md`);}
    if(query!==undefined){
      const candidates=new Set<string>(this.scope.files.filter(path=>this.allowed(path)));
      for(const folder of this.scope.folders){if(!safeVaultPath(folder))continue;for(const path of await this.vault.listTasks(folder,[]))if(this.allowed(path))candidates.add(path);}
      if(this.scope.dailyFolder&&safeVaultPath(this.scope.dailyFolder))for(const path of await this.vault.listTasks(this.scope.dailyFolder,[]))if(this.allowed(path))candidates.add(path);
      const needle=(query as string).toLocaleLowerCase();
      for(const path of candidates){const content=await this.vault.read(path);if(path.toLocaleLowerCase().includes(needle)||(content??'').toLocaleLowerCase().includes(needle))requested.add(path);}
    }
    const documents=[];
    for(const path of [...requested].sort()){const before=await this.vault.read(path),refs=this.document(path,before);documents.push({path,exists:before!==null,...refs});}
    return {documents};
  }

  private async read(input:unknown):Promise<unknown>{
    const args=this.args(input);this.onlyKeys(args,['documentRef','mode','ref','changeSetRef']);if(typeof args.documentRef!=='string')throw new Error('documentRef is required');
    if(args.changeSetRef!==undefined&&args.changeSetRef!==null&&(typeof args.changeSetRef!=='string'||!args.changeSetRef))throw new Error('changeSetRef must be a non-empty staged change reference or null');
    const document=this.refs.get(args.documentRef);if(!document||document.kind!=='document')throw new Error('Unknown document reference');if(!this.allowed(document.path))throw new Error('Document is outside the authorized scope');
    const mode=args.mode??'outline';if(!['outline','document','section','block'].includes(String(mode)))throw new Error('Invalid read mode');
    const staged=typeof args.changeSetRef==='string'?args.changeSetRef:undefined;
    let before:string|null,documentText:string,exists:boolean;
    if(staged){
      const changes=this.getStagedChanges(staged);
      for(const [path,baseline] of Object.entries(changes.dependencies))if(await this.vault.read(path)!==baseline)throw new Error(`Staged dependency changed after staging: ${path}`);
      const entry=changes.entries.find(change=>change.path===document.path);
      before=entry?entry.before:(Object.prototype.hasOwnProperty.call(changes.dependencies,document.path)?changes.dependencies[document.path]:await this.vault.read(document.path));
      documentText=entry?.after??before??'';
      exists=Boolean(entry)||before!==null;
    }else{
      before=await this.vault.read(document.path);documentText=before??'';exists=before!==null;
    }
    const versionRef=this.version(),structure=parseMarkdownStructure(documentText);
    const fresh:StoredRef={...document,before,documentText,start:0,end:documentText.length,text:documentText,read:true,versionRef,...(staged?{staged}:{staged:undefined})};this.refs.set(args.documentRef,fresh);this.dependencies.set(document.path,before);
    const sectionRefs=structure.sections.map(section=>{const ref=this.ref('section');this.refs.set(ref,{kind:'section',path:document.path,before,documentText,start:section.start,end:section.end,text:documentText.slice(section.start,section.end),read:true,documentRef:args.documentRef as string,versionRef,...(staged?{staged}:{})});return ref;});
    const blockRefs=structure.blocks.map(block=>{const ref=this.ref('block');this.refs.set(ref,{kind:'block',path:document.path,before,documentText,start:block.start,end:block.end,text:documentText.slice(block.start,block.end),read:true,documentRef:args.documentRef as string,versionRef,...(staged?{staged}:{})});return ref;});
    const outline=structure.sections.map((section,index)=>({sectionRef:sectionRefs[index],title:section.title,level:section.level,parentRef:section.parent===null?null:sectionRefs[section.parent]}));
    const base={documentRef:args.documentRef,versionRef,path:document.path,exists,frontmatter:structure.frontmatter? documentText.slice(structure.frontmatter.start,structure.frontmatter.end):null,...(staged?{changeSetRef:staged}:{})};
    if(mode==='outline')return {...base,sections:outline};
    if(mode==='document')return {...base,content:documentText,sections:outline,blocks:structure.blocks.map((block,index)=>({blockRef:blockRefs[index],sectionRef:block.section===null?null:sectionRefs[block.section],content:documentText.slice(block.start,block.end)}))};
    if(typeof args.ref!=='string')throw new Error(`${mode} mode requires ref`);
    const selected=this.refs.get(args.ref);if(!selected||!selected.read||selected.kind!==mode||selected.documentRef!==args.documentRef||selected.before!==before||selected.documentText!==documentText||selected.staged!==staged)throw new Error(`The ${mode} reference does not belong to the current document version`);this.refs.set(args.ref,{...selected,versionRef});
    if(mode==='block')return {...base,blockRef:args.ref,content:selected.text};
    const contained=structure.blocks.map((block,index)=>({block,index})).filter(({block})=>block.start>=selected.start&&block.end<=selected.end);
    return {...base,sectionRef:args.ref,content:selected.text,blocks:contained.map(({block,index})=>({blockRef:blockRefs[index],content:documentText.slice(block.start,block.end)}))};
  }

  private async stage(input:unknown):Promise<{changeSetRef:string;summary:string;changes:unknown}>{
    const args=this.args(input);this.onlyKeys(args,['changes','summary']);if(!Array.isArray(args.changes)||!args.changes.length)throw new Error('changes must be a non-empty array');if(args.summary!==undefined&&typeof args.summary!=='string')throw new Error('summary must be a string');
    const edits=args.changes as EditInput[];const byPath=new Map<string,{before:string|null;edits:Array<{start:number;end:number;text:string;order:number}>}>();
    for(let order=0;order<edits.length;order++){
      const edit=edits[order];if(!edit||typeof edit!=='object'||Array.isArray(edit))throw new Error('Invalid note change');this.onlyKeys(edit as unknown as Record<string,unknown>,['operation','targetRef','position','content']);if(!['insert','replace','delete'].includes(edit.operation)||typeof edit.targetRef!=='string')throw new Error('Invalid note change');
      const target=this.refs.get(edit.targetRef);if(!target)throw new Error('Unknown target reference');if(!this.allowed(target.path))throw new Error(`Target is outside scope: ${target.path}`);
      if(target.staged)throw new Error('stage_note_changes cannot consume staged references; commit and re-read the note, or compose it through a supported tool');
      const missingCreate=target.kind==='document'&&target.before===null;
      if(!target.read&&!missingCreate)throw new Error('Changes require a reference returned by read_note');
      if(missingCreate&&(edit.operation!=='insert'||!['append','end'].includes(edit.position??'append')))throw new Error('A missing discovered document can only be created by an append/end insertion');
      if(!missingCreate&&this.dependencies.get(target.path)!==target.before)throw new Error('The reference was superseded by a later read');
      if((edit.operation==='insert'||edit.operation==='replace')&&typeof edit.content!=='string')throw new Error(`${edit.operation} requires content`);
      if(edit.operation==='delete'&&edit.content!==undefined)throw new Error('delete does not accept content');
      const position=edit.position??(edit.operation==='insert'?'append':undefined);if(edit.operation!=='insert'&&position!==undefined)throw new Error('position is only valid for insert');
      let start=target.start,end=target.end,text='';
      if(edit.operation==='insert'){
        if(!['before','after','append','end'].includes(String(position)))throw new Error('Invalid insertion position');
        if(target.kind==='document'&&!['append','end'].includes(String(position)))throw new Error('Document insertions use append or end');
        start=end=position==='before'?target.start:target.end;
        const newline=parseMarkdownStructure(target.before??'').newline; text=normalizeMarkdownNewlines(edit.content!,newline);
        const source=target.before??'';if(start>0&&!/[\r\n]$/.test(source.slice(0,start))&&!/^[\r\n]/.test(text))text=newline+text;
        if(start<source.length&&!/^[\r\n]/.test(source.slice(start))&&!/[\r\n]$/.test(text))text+=newline;
      }else if(edit.operation==='replace')text=normalizeMarkdownNewlines(edit.content!,parseMarkdownStructure(target.before??'').newline); else text='';
      const group=byPath.get(target.path)??{before:target.before,edits:[]};if(group.before!==target.before)throw new Error('Changes for one note must use the same read version');group.edits.push({start,end,text,order});byPath.set(target.path,group);
    }
    const entries:FileChange[]=[];
    for(const [path,group] of byPath){
      const ranges=group.edits.filter(e=>e.start!==e.end).sort((a,b)=>a.start-b.start||a.end-b.end);for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new Error(`Overlapping changes for ${path}`);
      for(const insert of group.edits.filter(e=>e.start===e.end))if(ranges.some(range=>insert.start>range.start&&insert.start<range.end))throw new Error(`Insertion overlaps a replacement or deletion in ${path}`);
      let after=group.before??'';for(const edit of [...group.edits].sort((a,b)=>b.start-a.start||((b.end-b.start)-(a.end-a.start))||b.order-a.order))after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);
      if(after!==group.before)entries.push({path,before:group.before,after,...(group.before===null?{restored:''}:{})});
    }
    const summary=typeof args.summary==='string'&&args.summary.trim()?args.summary:`Stage ${entries.length} note change(s)`;
    const prepared=await this.prepare({entries,dependencies:{...this.getReadDependencies(),...Object.fromEntries(entries.map(e=>[e.path,e.before]))},summary},false,'stage');
    for(const entry of prepared.entries)await this.validateEdit?.(entry.path,entry.before,entry.after);
    return this.storeStage(prepared.entries,this.mergeDependencies(prepared.dependencies,prepared.entries),prepared.state??{},prepared.summary,false,prepared.validate);
  }

  private storeStage(entries:FileChange[],dependencies:Record<string,string|null>,stateAfter:{tracking?:Tracking;aiTasks?:Task[]},summary:string,trusted:boolean,validate?:()=>void|Promise<void>):{changeSetRef:string;summary:string;changes:unknown}{
    const changes=entries.map(entry=>({path:entry.path,before:entry.before,after:entry.after,...diffStats(entry.before??'',entry.after)}));
    const changeSetRef=this.ref('changeset'),stateBefore={tracking:this.state.getTracking?clone(this.state.getTracking()):undefined,aiTasks:this.state.getAiTasks?clone(this.state.getAiTasks()):undefined};
    this.stages.set(changeSetRef,{entries:clone(entries),dependencies:clone(dependencies),stateBefore,stateAfter:clone(stateAfter),summary,displayChanges:changes,trusted,validate});return {changeSetRef,summary,changes};
  }

  private operationId():string{return `operation_${crypto.randomUUID()}`;}
  private stateMatches(stage:StagedChangeSet):boolean{return (!this.state.getTracking||JSON.stringify(this.state.getTracking())===JSON.stringify(stage.stateBefore.tracking))&&(!this.state.getAiTasks||JSON.stringify(this.state.getAiTasks())===JSON.stringify(stage.stateBefore.aiTasks));}
  private receipt(receipt:OperationReceipt):OperationReceipt{this.receipts.push(receipt);return receipt;}
  private async commit(input:unknown):Promise<ToolResult>{
    const args=this.args(input);this.onlyKeys(args,['changeSetRef']);if(typeof args.changeSetRef!=='string')throw new Error('changeSetRef is required');if(this.recoveryRequired||stateUndo(this.state)?.status==='partial')throw new Error('A partial write must be undone before another commit');
    const stored=this.stages.get(args.changeSetRef);if(!stored)throw new Error('Unknown change set reference');const operationId=this.operationId();
    let stage:StagedChangeSet;
    try{
      const prepared=await this.prepare({entries:stored.entries,dependencies:stored.dependencies,...(stored.stateAfter.tracking!==undefined||stored.stateAfter.aiTasks!==undefined?{state:stored.stateAfter}:{}),summary:stored.summary,...(stored.validate?{validate:stored.validate}:{})},stored.trusted,'commit',stored.validate);
      const dependencies=this.mergeDependencies(prepared.dependencies,prepared.entries,stored.dependencies);
      stage={...stored,entries:prepared.entries,dependencies,stateAfter:prepared.state??{},summary:prepared.summary,displayChanges:prepared.entries.map(entry=>({path:entry.path,before:entry.before,after:entry.after,...diffStats(entry.before??'',entry.after)})),validate:prepared.validate};
    }catch(error){const message=(error as Error).message??String(error);const receipt=this.receipt({operationId,status:'conflict',changedFiles:[],stateChanges:[],warnings:[message],undoAvailable:false,summary:`Pre-commit preparation failed: ${message}`});return {ok:false,error:receipt.summary,receipt};}
    for(const entry of stage.entries)if(!this.allowed(entry.path))throw new Error(`Write is outside scope: ${entry.path}`);
    for(const [path,before] of Object.entries(stage.dependencies))if((!stage.trusted&&!this.allowed(path))||!safeVaultPath(path)||await this.vault.read(path)!==before){const receipt=this.receipt({operationId,status:'conflict',changedFiles:[],stateChanges:[],warnings:[],undoAvailable:false,summary:`Conflict: ${path} changed after it was read`});return {ok:false,error:receipt.summary,receipt};}
    if(!this.stateMatches(stage)){const receipt=this.receipt({operationId,status:'conflict',changedFiles:[],stateChanges:[],warnings:[],undoAvailable:false,summary:'Conflict: plugin state changed after staging'});return {ok:false,error:receipt.summary,receipt};}
    if(stage.validate)try{await stage.validate();}catch(error){const receipt=this.receipt({operationId,status:'conflict',changedFiles:[],stateChanges:[],warnings:[(error as Error).message],undoAvailable:false,summary:`Pre-commit validation failed: ${(error as Error).message}`});return {ok:false,error:receipt.summary,receipt};}
    const stateChanges=[...(stage.stateAfter.tracking!==undefined&&JSON.stringify(stage.stateAfter.tracking)!==JSON.stringify(stage.stateBefore.tracking)?['tracking']:[]),...(stage.stateAfter.aiTasks!==undefined&&JSON.stringify(stage.stateAfter.aiTasks)!==JSON.stringify(stage.stateBefore.aiTasks)?['aiTasks']:[])];
    if(!stage.entries.length&&!stateChanges.length){const receipt=this.receipt({operationId,status:'noop',changedFiles:[],stateChanges:[],warnings:[],undoAvailable:false,summary:stage.summary});return {ok:true,value:{operationId},receipt};}
    const effectiveTracking=stage.stateAfter.tracking??stage.stateBefore.tracking,effectiveAiTasks=stage.stateAfter.aiTasks??stage.stateBefore.aiTasks;
    const now=this.now().toISOString(),entries=clone(stage.entries);let undo={...(entries[0]??{}),entries,createdAt:now,operationId,status:'partial' as const,writtenPaths:[],trackingBeforeState:stage.stateBefore.tracking,trackingAfterState:effectiveTracking,aiTasksBefore:stage.stateBefore.aiTasks,aiTasksAfter:effectiveAiTasks} as UndoRecord;
    try{await this.state.saveUndo(undo,effectiveTracking,effectiveAiTasks);this.currentUndo=undo;}
    catch(error){const receipt=this.receipt({operationId,status:'failed',changedFiles:[],stateChanges:[],warnings:[(error as Error).message],undoAvailable:false,summary:`Backup failed: ${stage.summary}`});return {ok:false,error:(error as Error).message,receipt};}
    const written:string[]=[],attempted:string[]=[];
    try{
      for(const entry of entries){attempted.push(entry.path);await this.vault.writeChecked(entry.path,entry.before,entry.after);written.push(entry.path);undo={...undo,writtenPaths:[...written]};await this.state.saveUndo(undo,effectiveTracking,effectiveAiTasks);}
      for(const [path,before] of Object.entries(stage.dependencies)){
        const expected=entries.find(entry=>entry.path===path)?.after??before;
        let actual:string|null;try{actual=await this.vault.read(path);}catch(error){throw new Error(`Post-write dependency verification failed for ${path}: ${(error as Error).message}`);}
        if(actual!==expected)throw new Error(`A dependency changed while committing: ${path}`);
      }
      undo={...undo,status:'committed',writtenPaths:[...written]};await this.state.saveUndo(undo,effectiveTracking,effectiveAiTasks);this.currentUndo=undo;this.stages.delete(args.changeSetRef);
      const receipt=this.receipt({operationId,status:'committed',changedFiles:written,stateChanges,warnings:[],undoAvailable:true,summary:stage.summary});return {ok:true,value:{operationId,changeSetRef:args.changeSetRef},receipt};
    }catch(error){
      let uncertain=false;
      for(const path of attempted.filter(path=>!written.includes(path))){const entry=entries.find(entry=>entry.path===path)!;try{const current=await this.vault.read(path);if(current===entry.after)written.push(path);else if(current!==entry.before)uncertain=true;}catch{uncertain=true;}}
      const status=written.length||stateChanges.length||uncertain?'partial':'failed';undo={...undo,status,writtenPaths:[...written]};this.currentUndo=undo;if(status==='partial')this.recoveryRequired=true;
      try{await this.state.saveUndo(undo,effectiveTracking,effectiveAiTasks);}catch{/* The pre-write durable record remains the recovery source. */}
      const receipt=this.receipt({operationId,status,changedFiles:written,stateChanges,warnings:[(error as Error).message,...(uncertain?['A write outcome could not be confirmed. Inspect the recovery record before continuing.']:[])],undoAvailable:true,summary:status==='partial'?`Partial write: ${stage.summary}`:`Write failed: ${stage.summary}`});return {ok:false,error:(error as Error).message,receipt};
    }
  }

  private async undo(input:unknown):Promise<ToolResult>{
    const args=this.args(input);this.onlyKeys(args,['operationId']);if(typeof args.operationId!=='string')throw new Error('operationId is required');const record=this.state.getUndo?this.state.getUndo():stateUndo(this.state)??this.currentUndo;if(!record)throw new Error('No operation to undo');
    const operationId=undoOperationId(record);if(args.operationId!==operationId)throw new Error('The requested operation is not the latest undoable operation');const entries=record.entries??[record];for(const entry of entries)if(!this.allowed(entry.path))throw new Error(`Undo is outside the authorized scope: ${entry.path}`);
    if(record.aiTasksAfter&&this.state.getAiTasks&&JSON.stringify(record.aiTasksAfter)!==JSON.stringify(this.state.getAiTasks()))throw new Error('AI tasks changed; refusing to overwrite during undo');
    if(record.trackingAfterState&&this.state.getTracking&&JSON.stringify(record.trackingAfterState)!==JSON.stringify(this.state.getTracking()))throw new Error('Tracking changed; refusing to overwrite during undo');
    const pending:string[]=[];for(const entry of entries)if(await this.vault.read(entry.path)===entry.after)pending.push(entry.path);
    try{await undoLast(this.vault,this.state,record);this.currentUndo=null;this.recoveryRequired=false;
      const receipt=this.receipt({operationId,status:'committed',changedFiles:pending,stateChanges:[...(record.trackingAfterState!==undefined&&JSON.stringify(record.trackingAfterState)!==JSON.stringify(record.trackingBeforeState)?['tracking']:[]),...(record.aiTasksAfter!==undefined&&JSON.stringify(record.aiTasksAfter)!==JSON.stringify(record.aiTasksBefore)?['aiTasks']:[])],warnings:[],undoAvailable:false,summary:`Undid ${operationId}`});return {ok:true,value:{operationId},receipt};
    }catch(error){const restored:string[]=[];let uncertain=false;for(const entry of entries.filter(entry=>pending.includes(entry.path))){try{const current=await this.vault.read(entry.path);if(current===entry.before||current===entry.restored)restored.push(entry.path);}catch{uncertain=true;}}const durablePartial=stateUndo(this.state)?.status==='partial';this.recoveryRequired=durablePartial||restored.length>0||uncertain;
      const receipt=this.receipt({operationId,status:this.recoveryRequired?'partial':'failed',changedFiles:restored,stateChanges:[],warnings:[(error as Error).message,...(uncertain?['An undo write outcome could not be confirmed. The recovery record is retained.']:[])],undoAvailable:true,summary:`Undo incomplete for ${operationId}`});return {ok:false,error:(error as Error).message,receipt};}
  }
}
