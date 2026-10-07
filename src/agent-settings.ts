import { DEFAULT_AGENT_SETTINGS } from './types';
import type { AgentSettings } from './types';
import { safeVaultPath } from './time';
export function agentSettings(value:Partial<AgentSettings>|undefined):AgentSettings {
 const result={...DEFAULT_AGENT_SETTINGS,...value};
 for(const [paths,max] of [[result.noteFolders,32],[result.skillFiles,8]] as const)if(!Array.isArray(paths)||paths.length>max||paths.some(path=>!safeVaultPath(path))||new Set(paths).size!==paths.length)throw Error('Invalid AI scope or skill paths');
 if(result.skillFiles.some(path=>!path.endsWith('.md')))throw Error('Skill files must be vault-relative Markdown paths');
 if(!Number.isInteger(result.maxSteps)||result.maxSteps<2||result.maxSteps>128||!Number.isInteger(result.maxContextChars)||result.maxContextChars<20000||result.maxContextChars>1000000||!Number.isInteger(result.timeoutMs)||result.timeoutMs<15000||result.timeoutMs>600000)throw Error('Invalid AI execution budget');
 return result;
}
