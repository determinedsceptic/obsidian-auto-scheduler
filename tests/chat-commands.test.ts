import { it, expect, vi } from 'vitest';
import { isUndoCommand } from '../src/chat-commands';
vi.mock('obsidian',()=>({ItemView:class {contentEl={};app={};constructor(..._:unknown[]){}},Notice:vi.fn(),requestUrl:vi.fn()}));
import { ChatView } from '../src/chat-view';
import { requestUrl } from 'obsidian';
it.each(['undo','UNDO','/undo'])('recognizes standalone undo: %s',text=>expect(isUndoCommand(text)).toBe(true));
it.each(['撤销','撤销上一次操作','undo last operation','UNDO!','不要撤销','怎么撤销？','undo是什么','what does undo mean?','undo and copy tomorrow','撤销后复制到七天','撤销前天那个操作','撤销全部操作'])('does not interpret an ambiguous or informational request as undo: %s',text=>expect(isUndoCommand(text)).toBe(false));
function view(undoSchedule=vi.fn().mockResolvedValue({text:'Restored by host',notes:[]})){
 const plugin={state:{undo:{createdAt:'fixture'}},getApiToken:vi.fn().mockRejectedValue(Error('Must not read keys')),byok:{providers:[]},chatHistory:{sessions:[{id:'test',messages:[],draft:''}],activeId:'test'},undoSchedule};
 const v=new ChatView({} as any,plugin as any) as any;v.render=vi.fn();return {v,plugin};
}
it('executes typed undo before provider/key/model access, with only a host-confirmed reply',async()=>{
 const {v,plugin}=view();await v.send('undo');
 expect(plugin.undoSchedule).toHaveBeenCalledExactlyOnceWith(JSON.stringify(plugin.state.undo));expect(plugin.getApiToken).not.toHaveBeenCalled();expect(requestUrl).not.toHaveBeenCalled();
 expect(v.messages).toEqual([{role:'user',content:'undo'},{role:'assistant',content:'Restored by host',notes:[]}]);expect(v.busy).toBe(false);expect(v.applying).toBe(false);
});
it.each(['No schedule to undo','Output was modified; refusing to overwrite'])('shows host rollback failures instead of claiming success: %s',error=>{
 const {v,plugin}=view(vi.fn().mockRejectedValue(Error(error)));
 return v.send('undo').then(()=>{expect(plugin.getApiToken).not.toHaveBeenCalled();expect(v.messages.at(-1)).toMatchObject({content:`Undo failed: ${error}`,failed:true});expect(v.busy).toBe(false);});
});
it('prevents repeated submits while undo is running',async()=>{
 let finish!:(value:unknown)=>void;const host=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));const {v}=view(host);
 const pending=v.send('undo');await v.send('undo');expect(host).toHaveBeenCalledTimes(1);finish({text:'Done',notes:[]});await pending;
});
