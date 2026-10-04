import {expect,it} from 'vitest';
import {stageHabitFiles} from '../src/habit-files';
import {habitPath} from '../src/habit-tool';
import {validateGuidelineDocuments} from '../src/habit-guidelines';
import {readHabitIndex} from '../src/habit-index';
import {applyPreview,createPreview,undoLast} from '../src/transaction';
import {config,MemoryVault,now} from './helpers';
const settings=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true,blockBuffer:15});
it('saves separate titled habits and rules, indexes them, writes dated blocks and undoes all files together',async()=>{
  const v=new MemoryVault();v.files={};
  const habits=[{title:'午餐后快走',start:'12:40',end:'13:10',days:[0,1,2,3,4,5,6],priority:3},{title:'晚餐后快走',start:'18:40',end:'19:10',days:[0,1,2,3,4,5,6],priority:3},{title:'力量训练',start:'19:10',end:'19:40',days:[1,3,5],priority:4}];
  const docs=validateGuidelineDocuments({habits:[{title:'饮食规则',actions:[],conditions:['白水不限']}]});
  const staged=await stageHabitFiles(v,settings,habits,docs.flatMap(d=>d.rules),docs);
  expect(Object.keys(staged.updates)).toEqual(['Habits/午餐后快走.md','Habits/晚餐后快走.md','Habits/力量训练.md','Habits/饮食规则.md']);
  for(const [path,text] of Object.entries(staged.updates))expect(text.startsWith('# '+path.slice(7,-3)+'\n')).toBe(true);
  expect(v.writes).toBe(0);
  const p=await createPreview(v,settings,now,{},false,[],[],staged.updates);expect(p.result.errors).toEqual([]);
  await applyPreview(v,v,p,settings,now);
  const index=await readHabitIndex(v,settings);expect(index.index.files).toHaveLength(4);expect(index.index.files.flatMap(f=>f.habits)).toHaveLength(3);
  expect(v.files['DailyNotes/2026-10-02.md']).toContain('19:10 - 19:40');
  expect(v.files['DailyNotes/2026-10-02.md']).not.toContain('白水不限');
  await undoLast(v,v,v.undo);for(const path of Object.keys(staged.updates))expect(v.files[path]).toBe('');
});
it('names relative routines separately and deduplicates repeated rules within their own file',async()=>{
  const v=new MemoryVault();v.files={};
  const docs=validateGuidelineDocuments({habits:[{title:'午餐后快走',actions:['午餐后休息10分钟再快走30分钟'],conditions:[]},{title:'晚餐后快走',actions:['晚餐后休息10分钟再快走30分钟'],conditions:[]}]});
  const first=await stageHabitFiles(v,settings,[],docs.flatMap(d=>d.rules),docs);v.files={...first.updates};
  const second=await stageHabitFiles(v,settings,[],docs.flatMap(d=>d.rules),docs);expect(second.updates).toEqual(first.updates);
  expect(Object.keys(first.updates)).toHaveLength(2);
});
it('rejects generic titles and filename collisions without writing',async()=>{
  expect(()=>habitPath(settings,'Habits')).toThrow('specific');
  const v=new MemoryVault();v.files={'Habits/A B.md':'# Another habit\n'};
  await expect(stageHabitFiles(v,settings,[],[],[{title:'A/B',rules:['ACTION: Test']}])).rejects.toThrow('different habit');
  expect(v.writes).toBe(0);
});

it('persists confirmed anchors in guideline documents as authoritative timed rows across restart and repeat saves',async()=>{
  const v=new MemoryVault();v.files={};
  const docs=validateGuidelineDocuments({habits:[
    {title:'午餐后快走',actions:['午餐12:30结束，休息10分钟，再快走30分钟'],conditions:[],schedule:{start:'12:40',end:'13:10',days:[0,1,2,3,4,5,6],priority:3}},
    {title:'晚餐后快走',actions:['晚餐18:30结束，休息10分钟，再快走30分钟'],conditions:[],schedule:{start:'18:40',end:'19:10',days:[0,1,2,3,4,5,6],priority:3}},
    {title:'力量训练',actions:['每周一三五在晚间快走后训练'],conditions:[],schedule:{start:'19:10',end:null,days:[1,3,5],priority:3}},
    {title:'饮食规则',actions:[],conditions:['白水不限'],schedule:null},
  ]},45);
  expect(docs[2].schedule?.end).toBe('19:55');
  const staged=await stageHabitFiles(v,settings,[],docs.flatMap(d=>d.rules),docs);
  expect(staged.unresolvedRules).toEqual([]);
  const p=await createPreview(v,settings,now,{},false,[],[],staged.updates);expect(p.result.errors).toEqual([]);
  await applyPreview(v,v,p,settings,now);
  const index=await readHabitIndex(v,settings);
  expect(index.index.files.flatMap(f=>f.habits).map(h=>[h.start,h.end])).toEqual([['19:10','19:55'],['12:40','13:10'],['18:40','19:10']]);
  expect(v.files['Habits/午餐后快走.md']).toContain('12:40-13:10');
  const repeated=await stageHabitFiles(v,settings,[],docs.flatMap(d=>d.rules),docs);expect(repeated.updates).toEqual(staged.updates);
  const again=await createPreview(v,settings,now,v.tracking);expect(again.diff.added).toEqual([]);expect(again.result.errors).toEqual([]);
});
it('marks only genuinely unresolved actions as missing anchors',async()=>{
  const v=new MemoryVault();v.files={};
  const docs=validateGuidelineDocuments({habits:[{title:'午餐后快走',actions:['午餐后走30分钟'],conditions:[],schedule:null},{title:'饮食规则',actions:[],conditions:['白水不限'],schedule:null}]});
  const staged=await stageHabitFiles(v,settings,[],docs.flatMap(d=>d.rules),docs);
  expect(staged.unresolvedRules).toEqual(['ACTION: 午餐后走30分钟']);
});

it('reuses similar routine titles without changing IDs or duplicating timed rows',async()=>{
  const v=new MemoryVault();v.files={'Habits/午餐后快走.md':'# 午餐后快走\n- 12:40-13:10 🔼 午餐后快走 (Mon, Wed, Fri)\n'};
  const staged=await stageHabitFiles(v,settings,[{title:'每周午饭后散步',start:'12:40',end:'13:10',days:[1,3,5],priority:3}],[],[{title:'每天午餐结束后快走30分钟',rules:['ACTION: 饭后休息10分钟再走']}]);
  expect(Object.keys(staged.updates)).toEqual(['Habits/午餐后快走.md']);
  expect(staged.created.size).toBe(0);
  expect(staged.updates['Habits/午餐后快走.md'].match(/12:40-13:10/g)).toHaveLength(1);
  await expect(stageHabitFiles(v,settings,[{title:'午饭后散步',start:'13:00',end:'13:30',days:[1,3,5],priority:3}],[])).rejects.toThrow('different times');
});

it('groups inherited sentence rules under concise canonical filenames in a fresh vault',async()=>{
  const v=new MemoryVault();v.files={};
  const rules=['ACTION: 每天午餐结束后休息10分钟，再快走30分钟。','RULE: 正餐外默认不吃零食，不喝有热量的饮料。','RULE: 训练前后若明显饥饿，可以补充无糖酸奶。'];
  const staged=await stageHabitFiles(v,settings,[],rules);
  expect(Object.keys(staged.updates)).toEqual(['Habits/午餐后快走.md','Habits/饮食规则.md']);
  expect(staged.updates['Habits/饮食规则.md']).toContain('训练前后');
});
