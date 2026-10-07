export interface MarkdownSection {
  level: number;
  title: string;
  start: number;
  headingEnd: number;
  bodyStart: number;
  end: number;
  parent: number | null;
}

export interface MarkdownBlock {
  start: number;
  end: number;
  section: number | null;
}

export interface MarkdownStructure {
  newline: '\n' | '\r\n';
  frontmatter: { start: number; end: number } | null;
  sections: MarkdownSection[];
  blocks: MarkdownBlock[];
}

interface Line {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
}

function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < content.length) {
    const lf = content.indexOf('\n', start);
    const end = lf < 0 ? content.length : lf + 1;
    const contentEnd = lf < 0 ? end : lf > start && content[lf - 1] === '\r' ? lf - 1 : lf;
    lines.push({ start, contentEnd, end, text: content.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

/** Parse byte ranges only. Rendering always uses the original source text. */
export function parseMarkdownStructure(content: string): MarkdownStructure {
  const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = linesOf(content);
  let frontmatter: MarkdownStructure['frontmatter'] = null;
  let firstBodyLine = 0;
  if (lines[0]?.text === '---') {
    const close = lines.slice(1).findIndex(line => line.text === '---');
    if (close >= 0) {
      firstBodyLine = close + 2;
      frontmatter = { start: 0, end: lines[close + 1].end };
    }
  }

  const headings: Array<{ line: number; level: number; title: string }> = [];
  const fenced = new Set<number>();
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (let index = firstBodyLine; index < lines.length; index++) {
    const text = lines[index].text;
    if (fence) {
      fenced.add(index);
      const close = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(text)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (opening) {
      fence = { marker: opening[1][0] as '`' | '~', length: opening[1].length };
      fenced.add(index);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*#*[ \t]*|[ \t]*)$/.exec(text);
    if (heading) headings.push({ line: index, level: heading[1].length, title: heading[2] ?? '' });
  }

  const sections: MarkdownSection[] = headings.map((heading, index) => {
    let end = content.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) { end = lines[headings[next].line].start; break; }
    }
    let parent: number | null = null;
    for (let previous = index - 1; previous >= 0; previous--) {
      if (headings[previous].level < heading.level) { parent = previous; break; }
    }
    const line = lines[heading.line];
    return { level: heading.level, title: heading.title, start: line.start, headingEnd: line.end,
      bodyStart: line.end, end, parent };
  });

  const headingLines = new Set(headings.map(heading => heading.line));
  const blocks: MarkdownBlock[] = [];
  let index = firstBodyLine;
  const listIndent = (text: string): number | null => {
    const match = /^( {0,3})(?:[-+*]|\d+[.)])[ \t]+/.exec(text);
    return match ? match[1].length : null;
  };
  while (index < lines.length) {
    if (headingLines.has(index) || /^\s*$/.test(lines[index].text)) { index++; continue; }
    const start = index;
    if (fenced.has(index)) {
      index++;
      while (index < lines.length && fenced.has(index)) index++;
    } else if (listIndent(lines[index].text) !== null) {
      const rootIndent = listIndent(lines[index].text)!;
      index++;
      while (index < lines.length && !headingLines.has(index)) {
        const indent = listIndent(lines[index].text);
        if (indent !== null && indent <= rootIndent) break;
        if (/^\s*$/.test(lines[index].text)) {
          let next = index + 1;
          while (next < lines.length && /^\s*$/.test(lines[next].text)) next++;
          if (next >= lines.length || headingLines.has(next)) break;
          const nextIndent = listIndent(lines[next].text);
          const leading = /^( *)/.exec(lines[next].text)?.[1].length ?? 0;
          if ((nextIndent !== null && nextIndent <= rootIndent) || (nextIndent === null && leading <= rootIndent)) break;
        }
        index++;
      }
    } else {
      index++;
      while (index < lines.length && !headingLines.has(index) && !/^\s*$/.test(lines[index].text) && !fenced.has(index)) index++;
    }
    const rangeStart = lines[start].start;
    const rangeEnd = lines[index - 1].end;
    let section: number | null = null;
    for (let candidate = sections.length - 1; candidate >= 0; candidate--) {
      if (rangeStart >= sections[candidate].bodyStart && rangeStart < sections[candidate].end) { section = candidate; break; }
    }
    blocks.push({ start: rangeStart, end: rangeEnd, section });
  }
  return { newline, frontmatter, sections, blocks };
}

export function normalizeMarkdownNewlines(content: string, newline: '\n' | '\r\n'): string {
  return content.replace(/\r\n|\r|\n/g, newline);
}
