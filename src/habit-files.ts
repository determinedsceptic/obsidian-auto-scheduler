import { appendHabits, habitPath } from './habit-tool';
import type { HabitDraft } from './habit-tool';
import { appendGuidelines, validateGuidelines, readGuidelines } from './habit-guidelines';
import { parseHabits } from './habits';
import type { Settings } from './types';
import type { VaultPort } from './transaction';
export interface GuidelineDocument { title:string; rules:string[]; schedule?:HabitDraft|null; defaulted?:boolean }
/** Conservative semantic keys; distinct meal anchors stay distinct. */
export function habitKey(title:string):string {
  const text=title.normalize('NFKC').toLowerCase().replace(/\s|[，,。；;：:、()（）-]/g,'');
  if(/午餐|午饭|lunch/.test(text)&&/晚餐|晚饭|dinner/.test(text))return text;
  if(/午餐|午饭|lunch/.test(text)&&/快走|散步|walk/.test(text))return 'lunch-walk';
  if(/晚餐|晚饭|dinner/.test(text)&&/快走|散步|walk/.test(text))return 'dinner-walk';
  if(/力量训练|strengthtraining/.test(text))return 'strength-training';
  if(/规律.*三餐|regularmeals/.test(text))return 'regular-meals';
  if(/^饮食规则$|^dietaryrules$|正餐外.*(?:零食|热量)|训练前后.*饥饿/.test(text))return 'dietary-rules';
  return text;
}
export function guidelineTitle(rule:string):string {
  const text=rule.replace(/^(?:ACTION|RULE):\s*/,'').trim();
  const names:Record<string,string[]>= {'lunch-walk':['午餐后快走','Lunch walk'],'dinner-walk':['晚餐后快走','Dinner walk'],'strength-training':['力量训练','Strength training'],'regular-meals':['规律三餐','Regular meals'],'dietary-rules':['饮食规则','Dietary rules']};
  const name=names[habitKey(text)];
  return name?name[/[\u4e00-\u9fff]/.test(text)?0:1]:text.split(/[。；;\n]/)[0].trim();
}
export async function stageHabitFiles(vault:VaultPort,settings:Settings,habits:HabitDraft[],guidelines:string[],documents:GuidelineDocument[]=[]){
  const updates:Record<string,string>={},originals:Record<string,string|null>={},created=new Set<string>();
  const titles=new Map<string,string>();
  const existingFiles=await vault.listTasks(settings.habitFolder,[]);
  const candidates: {path:string;title:string}[]=[];
  for(const path of existingFiles){
    const content=await vault.read(path);
    const title=/^# ([^\r\n]+)$/m.exec(content??'')?.[1];
    if(title)candidates.push({path,title});
  }
  async function load(title:string){
    const matches=candidates.filter(c=>habitKey(c.title)===habitKey(title));
    const exact=matches.find(c=>c.title===title);
    const match=exact??(matches.length===1?matches[0]:undefined);
    if(!match&&matches.length>1)throw Error('Several similar habit templates exist. Consolidate them before creating another.');
    const path=match?.path??habitPath(settings,title);
    title=match?.title??title;
    if(!match)candidates.push({path,title});
    if(titles.has(path)&&titles.get(path)!==title)throw Error('Habit titles produce the same filename. Use distinct specific titles.');
    titles.set(path,title);
    if(!(path in originals)){originals[path]=await vault.read(path);
      const heading=/^# ([^\r\n]+)$/m.exec(originals[path]??'')?.[1];
      if(heading&&heading!==title)throw Error('Filename already belongs to a different habit. Use a distinct specific title.');
      updates[path]=originals[path]??`# ${title}\n`;}
    return path;
  }
  async function saveSchedule(path:string,draft:HabitDraft){
    const existing=parseHabits([{path,content:updates[path]}],settings.defaultEventDuration);
    if(existing.errors.length)throw Error(existing.errors.map(e=>e.message).join('\n'));
    const match=existing.habits.find(h=>habitKey(h.title)===habitKey(draft.title));
    if(match){
      if(match.start!==draft.start||match.end!==draft.end||match.priority!==draft.priority||JSON.stringify([...match.days].sort())!==JSON.stringify([...draft.days].sort()))throw Error('Habit already has different times. Edit its time row before rescheduling.');
      return;
    }
    const title=/^# ([^\r\n]+)$/m.exec(updates[path])?.[1]??draft.title;
    updates[path]=appendHabits(updates[path],[{...draft,title}],settings.defaultEventDuration);
  }
  for(const h of habits){const path=await load(h.title);await saveSchedule(path,h);}
  const represented=new Set(documents.flatMap(d=>d.rules));
  const items:GuidelineDocument[]=[...documents,...guidelines.filter(rule=>!represented.has(rule)).map(rule=>({title:guidelineTitle(rule),rules:[rule]}))];
  for(const item of items){
    const path=await load(item.title);
    if(item.schedule){
      if(item.schedule.title!==item.title)throw Error('Habit schedule title must match its document');
      await saveSchedule(path,item.schedule);
    }
    updates[path]=appendGuidelines(updates[path],validateGuidelines({rules:item.rules}));
  }
  for(const path of Object.keys(updates)){
    const previous=new Set(parseHabits([{path,content:originals[path]??''}],settings.defaultEventDuration).habits.map(h=>h.id));
    for(const h of parseHabits([{path,content:updates[path]}],settings.defaultEventDuration).habits)if(!previous.has(h.id))created.add(h.id);
  }
  const unresolvedRules=Object.entries(updates).flatMap(([path,content])=>parseHabits([{path,content}],settings.defaultEventDuration).habits.length?[]:readGuidelines(content).filter(r=>r.startsWith('ACTION: ')));
  return {updates,originals,created,unresolvedRules};
}
