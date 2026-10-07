import { calendarDate } from './calendar-format';
import { END, START, parseOutput, renderOutput, displayTitle } from './output';
import { parseEventMetadata } from './event-tool';
import { parseMarkdownStructure } from './markdown-structure';
import { visibleLines } from './parser';
import { addDays, localMinute, endAfter } from './time';
import type { Block, Diagnostic, Interval, OutputDocument, Settings } from './types';
export function dailyPaths(settings: Settings, today: string): string[] {
  return Array.from({ length: 7 }, (_, i) => `${settings.dailyFolder}/${addDays(today, i)}.md`);
}
export interface Section { start: number; end: number }
export function dayPlannerSection(content: string): Section | undefined {
  const lines = content.split(/\r?\n/), visible = visibleLines(content);
  const headings = visible.filter(l => /^#{1,6}\s+Day planner\s*#*\s*$/i.test(l.text));
  if (headings.length > 1) throw new Error('Duplicate Day planner headings; refusing to write');
  if (!headings.length) return undefined;
  const heading = headings[0], level = /^#+/.exec(heading.text)![0].length;
  const next = visible.find(l => l.line > heading.line && new RegExp(`^#{1,${level}}\\s+`).test(l.text));
  const offsets: number[] = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + (content.includes('\r\n') ? 2 : 1); }
  return { start: Math.min(offsets[heading.line] ?? content.length, content.length), end: next ? offsets[next.line - 1] : content.length };
}
/** Prepare a managed region only inside the intended heading; retain external bytes. */
export function dailyDocument(content: string | null): OutputDocument {
  let text = content ?? ''; const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let part = dayPlannerSection(text);
  if (!part) {
    if (text.includes(START) || text.includes(END)) throw new Error('Managed region is outside the Day planner heading');
    text += (text ? (text.endsWith('\n') ? newline : newline + newline) : '') + `# Day planner${newline}`;
    part = dayPlannerSection(text)!;
  }
  const region = text.slice(part.start, part.end);
  if (text.includes(START) || text.includes(END)) {
    if (!region.includes(START) || !region.includes(END)) throw new Error('The managed region must be entirely under the Day planner heading');
    return parseOutput(text);
  }
  const prefix = text.slice(0, part.end);
  return { prefix: prefix + (prefix && !prefix.endsWith('\n') ? newline : ''), suffix: newline + text.slice(part.end), newline, blocks: [] };
}
export function renderDaily(document: OutputDocument, blocks: Block[], mode: Settings['outputMode'], ganttFilter = '🎯'): string {
  // Date lives in the note name and in Gantt fields. A date subheading is unnecessary.
  const rendered = renderOutput({ ...document, prefix: '', suffix: '' }, blocks, mode, ganttFilter)
    .split(document.newline).filter(line => !/^## \d{4}-\d{2}-\d{2}$/.test(line)).join(document.newline);
  return document.prefix + rendered + document.suffix;
}
export interface DailyEventRow extends Interval {
  sourceStart:number; sourceEnd:number; line:number; raw:string; title:string; body:string; reminder:string|null;
  checkbox:boolean; completed:boolean; standalone:boolean; flexible:boolean;
}
export function isFlexibleDailyRow(row:DailyEventRow):boolean {
  return row.flexible&&row.checkbox&&!row.completed&&row.standalone&&row.reminder!==null&&!!row.body;
}
/** Exact template identity; display decorations are not part of an activity title. */
export function calendarTitle(title:string):string {
  return displayTitle(title).replace(/\s+/g,' ').trim();
}
export function dailyInputs(path: string, content: string | null, defaultDuration = 30): { content: string; intervals: Interval[]; rows:DailyEventRow[]; errors: Diagnostic[] } {
  const text = content ?? '', part = dayPlannerSection(text); const intervals: Interval[] = [], rows:DailyEventRow[] = [], errors: Diagnostic[] = [];
  if (!part) return { content: '', intervals, rows, errors };
  const date = path.split('/').pop()!.slice(0, -3);
  const startLine = text.slice(0, part.start).split('\n').length;
  let managed = false;
  const selected: string[] = [];
  const structure=parseMarkdownStructure(text), sourceLines=text.slice(part.start,part.end).split(/\r?\n/);
  const offsets:number[]=[];let offset=part.start;
  for(const line of sourceLines){offsets.push(offset);offset+=line.length+structure.newline.length;}
  for (const { text: line, line: number } of visibleLines(text.slice(part.start, part.end))) {
    if (line.trim() === START) { managed = true; selected.push(''); continue; }
    if (line.trim() === END) { managed = false; selected.push(''); continue; }
    selected.push(managed ? '' : line);
    if (managed) continue;
    try {
      const time = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})(?:\s|$)/.exec(line);
      const startOnly = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(\d{2}:\d{2})(?:\s+[^-\s].*)?$/.exec(line);
      const calendarStart = calendarDate(line, 'start') ?? calendarDate(line, 'scheduled');
      const calendarEnd = calendarDate(line, 'due');
      let interval: Interval | undefined;
      if (time) interval = { start: localMinute(date, time[1]), end: localMinute(date, time[2]) };
      else if (startOnly && !/<!--\s*as\s|%%\[as::/.test(line)) interval = { start: localMinute(date, startOnly[1]), end: localMinute(date, endAfter(startOnly[1], defaultDuration)) };
      else if (!/<!--\s*as\s|%%\[as::/.test(line) && calendarStart !== undefined && calendarEnd !== undefined && /(?:\[(?:start|scheduled)::|[🛫⏳])\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/ui.test(line) && /(?:\[due::|📅)\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/ui.test(line)) interval = { start: calendarStart, end: calendarEnd };
      if (interval) {
        if (interval.end <= interval.start) throw new Error('A handwritten daily event must end after it starts');
        const buffers=parseEventMetadata(line);
        if(buffers)Object.assign(interval,buffers);
        const flexibleMarkers=line.match(/<!--\s*as-flexible\b/g)??[];
        if(flexibleMarkers.length&&(flexibleMarkers.length!==1||! /<!--\s*as-flexible\s*-->/.test(line)))throw Error('Invalid flexible calendar metadata');
        if(buffers&&flexibleMarkers.length)throw Error('A calendar row cannot be both a fixed event and a flexible plan');
        const sourceStart=offsets[number-1],sourceEnd=Math.min(offsets[number]??text.length,part.end);
        const block=structure.blocks.find(block=>block.start===sourceStart);
        const check=/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX-])\]\s+/.exec(line);
        const body=displayTitle(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/,'').replace(/^\d{2}:\d{2}(?:\s*-\s*\d{2}:\d{2})?\s*/,''));
        const timedFields=/(?:\[(?:start|scheduled|due)::|[🛫⏳📅])\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/ui.test(line);
        const ownedDirective=/<!--\s*(?:as|as-block)(?:\s|-->)|%%\[(?:as|as-block)::/.test(line);
        const reminder=(time||startOnly)&&!timedFields&&!ownedDirective?line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)\d{2}:\d{2}(?:\s*-\s*\d{2}:\d{2})?\s*/,'$1'):null;
        rows.push({...interval,sourceStart,sourceEnd,line:startLine+number-1,raw:line,title:calendarTitle(body),body,reminder,
          checkbox:!!check,completed:!!check&&check[1]!==' ',standalone:!!block&&block.end===sourceEnd,flexible:!!flexibleMarkers.length});
        intervals.push(interval);
      }
    } catch (error) { errors.push({ path, line: startLine + number - 1, message: (error as Error).message }); }
  }
  return { content: '\n'.repeat(startLine - 1) + selected.join('\n'), intervals, rows, errors };
}

/** Only the explicitly named task section is exposed to AI; journals remain private. */
export function taskSection(content: string): Section | undefined {
  const headings=visibleLines(content).filter(l=>/^# Tasks\s*#*\s*$/i.test(l.text));
  if(headings.length>1)throw Error('Duplicate Tasks headings; refusing to write');
  if(!headings.length)return undefined;
  const lines=content.split(/\r?\n/), offsets:number[]=[];let offset=0;
  for(const line of lines){offsets.push(offset);offset+=line.length+(content.includes('\r\n')?2:1);}
  const next=visibleLines(content).find(l=>l.line>headings[0].line&&/^#\s+/.test(l.text));
  return {start:offsets[headings[0].line]??content.length,end:next?offsets[next.line-1]:content.length};
}
export function appendTaskRows(text:string, rows:string[]):string {
  if(!rows.length)return text;
  const newline=text.includes('\r\n')?'\r\n':'\n',part=taskSection(text);
  if(part)return text.slice(0,part.end)+(text.slice(0,part.end).endsWith('\n')?'':newline)+rows.join(newline)+newline+text.slice(part.end);
  const frontmatter=/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)?.[0]??'';
  return frontmatter+(frontmatter&&!frontmatter.endsWith('\n')?newline:'')+'# Tasks'+newline+newline+rows.join(newline)+newline+newline+text.slice(frontmatter.length);
}
/** Move only standalone untimed checkboxes, retaining all other note bytes. */
export function organizeDailyTasks(text:string,defaultDuration=30):string {
  const part=dayPlannerSection(text);taskSection(text);if(!part)return text;
  const rows=visibleLines(text),lines=text.split(/\r?\n/),newline=text.includes('\r\n')?'\r\n':'\n';
  const offsets:number[]=[];let offset=0;for(const line of lines){offsets.push(offset);offset+=line.length+newline.length;}
  const moved:string[]=[],remove=new Set<number>();let managed=false;
  for(const row of rows){
    const at=offsets[row.line-1];if(at<part.start||at>=part.end)continue;
    if(row.text===START){managed=true;continue;}if(row.text===END){managed=false;continue;}
    const startOnly=/^([-*+] \[[ xX]\] )(\d{2}:\d{2})\s+([^-\s].*)$/.exec(row.text);
    if(!managed&&startOnly){lines[row.line-1]=`${startOnly[1]}${startOnly[2]} - ${endAfter(startOnly[2],defaultDuration)} ${startOnly[3]}`;continue;}
    if(managed||!/^[-*+] \[[ xX]\] /.test(row.text)||/^[-*+] \[[ xX]\] \d{2}:\d{2}(?:\s|$)/.test(row.text))continue;
    // Multi-line items and source-managed directives require explicit editing.
    if(/^\s{2,}\S/.test(lines[row.line]??'')||/<!--|%%|\[\[|[🛫⏳]\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(row.text))continue;
    moved.push(row.text);remove.add(row.line-1);
  }
  return appendTaskRows(lines.filter((_,i)=>!remove.has(i)).join(newline),moved);
}
