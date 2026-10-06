import {it,expect} from 'vitest';
import {releaseEditedTracking} from '../src/tracking-recovery';
import {cleanDaily,rehydrate} from '../src/tracking';
import {dailyDocument,renderDaily,dailyInputs} from '../src/daily';
import {createPreview,applyPreview,undoLast} from '../src/transaction';
import {block,config,MemoryVault,now} from './helpers';
const settings=config({outputLocation:'daily',outputMode:'day-planner',cleanDaily:true});
const path='DailyNotes/2026-10-01.md';
const clean=cleanDaily(renderDaily(dailyDocument(null),[block({locked:false})],'day-planner'));
const tracking={[path]:{before:null,after:clean.record}};
const edited='# Tasks\n- [ ] Long goal 📅 2026-10-20\n# Day planner\n- [x] 10:30 - 12:00 Algorithms ✅ 2026-10-01\n# Journal\nKeep my writing\n';
it('explicit recovery leaves notes, original tracking and unrelated ownership unchanged',()=>{
  const original=structuredClone({...tracking,'DailyNotes/2026-10-02.md':tracking[path]});
  const next=releaseEditedTracking(path,edited,original,settings);
  expect(next[path]).toBeUndefined();expect(next['DailyNotes/2026-10-02.md']).toEqual(original['DailyNotes/2026-10-02.md']);
  expect(original[path]).toEqual(tracking[path]);expect(rehydrate(edited,next[path])).toBe(edited);
  expect(dailyInputs(path,edited).intervals).toHaveLength(1);
  expect(()=>rehydrate(edited,original[path])).toThrow('refusing to overwrite');
});
it('rejects unrelated paths, matching tracking and invalid sections',()=>{
  for(const p of ['../secret.md','Tasks/2026-10-01.md','DailyNotes/2026-02-30.md','DailyNotes/sub/2026-10-01.md'])expect(()=>releaseEditedTracking(p,edited,tracking,settings)).toThrow();
  expect(()=>releaseEditedTracking(path,clean.text,tracking,settings)).toThrow('unnecessary');
  expect(()=>releaseEditedTracking(path,edited,{},settings)).toThrow('no generated');
  expect(()=>releaseEditedTracking(path,edited+'# Day planner\n',tracking,settings)).toThrow('Duplicate');
});
it('replans after explicit recovery without altering handwritten rows, then undoes exactly',async()=>{
  const v=new MemoryVault();v.files[path]=edited;v.tracking=releaseEditedTracking(path,edited,tracking,settings);
  const p=await createPreview(v,settings,now,v.tracking);
  expect(p.result.errors).toEqual([]);await applyPreview(v,v,p,settings,now);
  expect(v.files[path]).toContain('- [x] 10:30 - 12:00 Algorithms ✅ 2026-10-01');
  expect(v.files[path]).toContain('# Journal\nKeep my writing');
  expect(v.files[path]).not.toContain('auto-scheduler:start');
  await undoLast(v,v,v.undo);expect(v.files[path]).toBe(edited);
});

it('attributes a tracking conflict to its actual note',()=>{
  expect(()=>rehydrate(edited,tracking[path],path)).toThrow(`${path}: Generated blocks were edited`);
});
