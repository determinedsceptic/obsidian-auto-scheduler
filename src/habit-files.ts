import { appendHabits, habitPath } from './habit-tool';
import type { HabitDraft } from './habit-tool';
import { appendGuidelines, validateGuidelines } from './habit-guidelines';
import { parseHabits } from './habits';
import type { Settings } from './types';
import type { VaultPort } from './transaction';
export interface GuidelineDocument { title:string; rules:string[] }
export function guidelineTitle(rule:string):string {
  return rule.replace(/^(?:ACTION|RULE):\s*/,'').split(/[。；;\n]/)[0].trim();
}
export async function stageHabitFiles(vault:VaultPort,settings:Settings,habits:HabitDraft[],guidelines:string[],documents:GuidelineDocument[]=[]){
  const updates:Record<string,string>={},originals:Record<string,string|null>={},created=new Set<string>();
  const titles=new Map<string,string>();
  async function load(title:string){
    const path=habitPath(settings,title);
    if(titles.has(path)&&titles.get(path)!==title)throw Error('Habit titles produce the same filename. Use distinct specific titles.');
    titles.set(path,title);
    if(!(path in originals)){originals[path]=await vault.read(path);
      const heading=/^# ([^\r\n]+)$/m.exec(originals[path]??'')?.[1];
      if(heading&&heading!==title)throw Error('Filename already belongs to a different habit. Use a distinct specific title.');
      updates[path]=originals[path]??`# ${title}\n`;}
    return path;
  }
  for(const h of habits){const path=await load(h.title);updates[path]=appendHabits(updates[path],[h],settings.defaultEventDuration);}
  const represented=new Set(documents.flatMap(d=>d.rules));
  const items=[...documents,...guidelines.filter(rule=>!represented.has(rule)).map(rule=>({title:guidelineTitle(rule),rules:[rule]}))];
  for(const item of items){const path=await load(item.title);updates[path]=appendGuidelines(updates[path],validateGuidelines({rules:item.rules}));}
  for(const path of Object.keys(updates)){
    const previous=new Set(parseHabits([{path,content:originals[path]??''}],settings.defaultEventDuration).habits.map(h=>h.id));
    for(const h of parseHabits([{path,content:updates[path]}],settings.defaultEventDuration).habits)if(!previous.has(h.id))created.add(h.id);
  }
  return {updates,originals,created};
}
