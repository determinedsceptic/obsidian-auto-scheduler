/** Exact local command aliases; ordinary natural language goes through the harness. */
export function isUndoCommand(value:string):boolean {return ['undo','/undo'].includes(value.trim().toLowerCase());}
