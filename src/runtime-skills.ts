import noteEditing from '../skills/note-editing/SKILL.md?raw';
import scheduling from '../skills/scheduling/SKILL.md?raw';

export interface RuntimeSkills {
  instructions: string;
  versions: Array<{ path: string; version: string }>;
}

const MAX_FILES = 8;
const MAX_CHARS = 40_000;
const bundled = [
  { path: 'bundled:note-editing', content: noteEditing },
  { path: 'bundled:scheduling', content: scheduling },
];

/** Deterministic FNV-1a hash; versioning does not depend on Node crypto. */
export function runtimeSkillVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 500 || path.includes('\\') || path.startsWith('/')
    || /[\x00-\x1f:*?"<>|]/.test(path) || /%(?:2e|2f|5c)/i.test(path) || !path.toLowerCase().endsWith('.md')) {
    throw new Error(`Runtime skill path must be a vault-relative Markdown path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`Runtime skill path contains an unsafe segment: ${path}`);
  }
  const reserved = /^(?:node_modules|plugins?|system|credentials?|secrets?|tokens?)$/i;
  if (parts.some(part => reserved.test(part.replace(/\.md$/i, '')))) {
    throw new Error(`Runtime skill path cannot use a system, plugin, or credential location: ${path}`);
  }
}

export async function loadRuntimeSkills(
  readFile: (path: string) => Promise<string | null>,
  configuredPaths: string[],
): Promise<RuntimeSkills> {
  if (!Array.isArray(configuredPaths)) throw new Error('Runtime skill paths must be an array');
  if (configuredPaths.length > MAX_FILES) throw new Error(`Configure at most ${MAX_FILES} runtime skill files`);
  if (new Set(configuredPaths).size !== configuredPaths.length) throw new Error('Runtime skill paths must be unique');
  for (const path of configuredPaths) validatePath(path);

  const custom: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const path of configuredPaths) {
    const content = await readFile(path);
    if (content === null) throw new Error(`Configured runtime skill is missing: ${path}`);
    if (typeof content !== 'string') throw new Error(`Configured runtime skill could not be read as Markdown: ${path}`);
    total += content.length;
    if (total > MAX_CHARS) throw new Error(`Runtime skill instructions exceed the ${MAX_CHARS}-character limit`);
    custom.push({ path, content });
  }

  // Explicit runtime files replace the packaged defaults. This lets a user
  // change the operating procedure without rebuilding the plugin.
  const all = custom.length ? custom : bundled;
  const instructions = all.map((skill, index) => {
    const kind = custom.length ? 'User-configured runtime skill' : 'Bundled runtime skill';
    return `## ${kind}: ${skill.path}\n\n${skill.content.trim()}`;
  }).join('\n\n');
  return {
    instructions,
    versions: all.map(skill => ({ path: skill.path, version: runtimeSkillVersion(skill.content) })),
  };
}
