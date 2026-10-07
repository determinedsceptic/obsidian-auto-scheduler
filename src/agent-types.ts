import type { FileChange, Task, Tracking } from './types';
export interface ToolDefinition { name:string; description:string; parameters:Record<string,unknown>; strict?:boolean }
export interface ToolCall { id:string; name:string; arguments:unknown }
export interface OperationReceipt {
 operationId:string; status:'committed'|'noop'|'conflict'|'partial'|'failed'; changedFiles:string[];
 stateChanges:string[]; warnings:string[]; undoAvailable:boolean; summary:string;
}
export interface ToolResult { ok:boolean; value?:unknown; error?:string; receipt?:OperationReceipt }
export interface AgentScope { folders:string[]; files:string[]; dailyFolder?:string }
export interface StagedState { tracking?:Tracking; aiTasks?:Task[] }
export interface ExternalChanges { entries:FileChange[]; dependencies:Record<string,string|null>; state?:StagedState; summary:string; validate?:()=>void|Promise<void> }
export interface AgentRuntime {
 tools:ToolDefinition[]; execute(name:string,args:unknown):Promise<ToolResult>; receipts:OperationReceipt[];
}
