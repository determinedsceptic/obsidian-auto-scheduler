import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-harness';
import { loadRuntimeSkills, runtimeSkillVersion } from '../src/runtime-skills';

describe('runtime skills', () => {
  it('loads bundled defaults without accessing runtime files', async () => {
    let reads = 0;
    const loaded = await loadRuntimeSkills(async () => { reads++; return null; }, []);
    expect(reads).toBe(0);
    expect(loaded.instructions).toContain('discover_notes');
    expect(loaded.instructions).toContain('Allocate time only when the user explicitly asks');
    expect(loaded.instructions).not.toContain('meal');
    expect(loaded.versions.map(item => item.path)).toEqual(['bundled:note-editing', 'bundled:scheduling']);
  });

  it('observes an edited configured skill on the next load and records a stable content version', async () => {
    let content = '# Local rules\nUse the Existing heading.';
    const read = async (path: string) => path === 'Skills/local.md' ? content : null;
    const first = await loadRuntimeSkills(read, ['Skills/local.md']);
    const firstVersion = first.versions.at(-1)?.version;
    expect(first.instructions).toContain('Use the Existing heading.');
    expect(first.instructions).not.toContain('discover_notes');
    expect(first.versions).toHaveLength(1);
    expect(firstVersion).toBe(runtimeSkillVersion(content));
    content = '# Local rules\nUse the Project heading.';
    const second = await loadRuntimeSkills(read, ['Skills/local.md']);
    expect(second.instructions).toContain('Use the Project heading.');
    expect(second.instructions).not.toContain('Use the Existing heading.');
    expect(second.versions.at(-1)?.version).not.toBe(firstVersion);
    expect(second.versions.at(-1)?.version).toBe(runtimeSkillVersion(content));
  });

  it('places a freshly edited runtime override in the next model request', async () => {
    let content = '# Rule\nUse format A.';
    const read = async () => content;
    await loadRuntimeSkills(read, ['Skills/local.md']);
    content = '# Rule\nUse format B.';
    const edited = await loadRuntimeSkills(read, ['Skills/local.md']);
    const result = await runAgent(
      { protocol: 'responses', baseUrl: 'https://example.test/v1', model: 'fixture' },
      'token', [{ role: 'user', content: 'reply' }], edited.instructions,
      { tools: [], receipts: [], execute: async () => ({ ok: false }) },
      async (_url, _headers, body) => {
        const request = JSON.parse(body);
        expect(request.instructions).toContain('Use format B.');
        expect(request.instructions).not.toContain('Use format A.');
        return { status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } };
      },
      { maxSteps: 2, maxContextChars: 10_000, timeoutMs: 1_000 },
    );
    expect(result.text).toBe('ok');
  });

  it.each([
    '../skill.md', '/skill.md', '.obsidian/skill.md', 'plugins/skill.md',
    'Credentials/api.md', 'Skills/skill.txt', 'Skills\\skill.md', 'C:/skill.md',
  ])('rejects unsafe configured path %s', async path => {
    await expect(loadRuntimeSkills(async () => 'text', [path])).rejects.toThrow(/path|location|segment/i);
  });

  it('reports a configured skill that is missing', async () => {
    await expect(loadRuntimeSkills(async () => null, ['Skills/missing.md'])).rejects.toThrow('Configured runtime skill is missing: Skills/missing.md');
  });

  it('bounds configured file count and combined instruction size', async () => {
    const paths = Array.from({ length: 9 }, (_, index) => `Skills/${index}.md`);
    await expect(loadRuntimeSkills(async () => 'x', paths)).rejects.toThrow('at most 8');
    await expect(loadRuntimeSkills(async () => 'x'.repeat(40_001), ['Skills/large.md'])).rejects.toThrow('40000-character');
  });
});
