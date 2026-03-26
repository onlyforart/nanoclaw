/**
 * Tests for remote MCP server support (Steps 1-3 of the Remote MCP Servers plan).
 *
 * Tests are derived from the specification (docs/REMOTE-MCP-SERVERS.md),
 * not from knowledge of the implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveTools,
  rewriteUrlForContainer,
  isRemoteEntry,
  classifyServerEntry,
  assembleSkillContent,
  resolveRemoteSkillContent,
} from './remote-mcp.js';

// ---------------------------------------------------------------------------
// resolveTools
// ---------------------------------------------------------------------------
describe('resolveTools', () => {
  it('passes through a flat array unchanged', () => {
    expect(resolveTools(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('flat array ignores readOnly flag', () => {
    expect(resolveTools(['a', 'b'], true)).toEqual(['a', 'b']);
  });

  it('access-level object with readOnly=true returns only read tools', () => {
    const tools = {
      read: ['find', 'count'],
      write: ['insert'],
      admin: ['drop'],
    };
    expect(resolveTools(tools, true)).toEqual(['find', 'count']);
  });

  it('access-level object with readOnly=false returns all tools', () => {
    const tools = { read: ['find'], write: ['insert'], admin: ['drop'] };
    expect(resolveTools(tools, false)).toEqual(['find', 'insert', 'drop']);
  });

  it('access-level object with no readOnly returns all tools', () => {
    const tools = { read: ['find'], write: ['insert'] };
    expect(resolveTools(tools)).toEqual(['find', 'insert']);
  });

  it('access-level object with readOnly=true and no read key returns empty', () => {
    const tools = { write: ['insert'], admin: ['drop'] };
    expect(resolveTools(tools, true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rewriteUrlForContainer
// ---------------------------------------------------------------------------
describe('rewriteUrlForContainer', () => {
  it('rewrites localhost to host.docker.internal', () => {
    expect(rewriteUrlForContainer('http://localhost:3200/mcp')).toBe(
      'http://host.docker.internal:3200/mcp',
    );
  });

  it('rewrites 127.0.0.1 to host.docker.internal', () => {
    expect(rewriteUrlForContainer('http://127.0.0.1:3200/mcp')).toBe(
      'http://host.docker.internal:3200/mcp',
    );
  });

  it('does not rewrite external URLs', () => {
    expect(rewriteUrlForContainer('https://mcp.example.com/mcp')).toBe(
      'https://mcp.example.com/mcp',
    );
  });

  it('does not rewrite docker bridge IP', () => {
    expect(rewriteUrlForContainer('http://172.17.0.1:3200/mcp')).toBe(
      'http://172.17.0.1:3200/mcp',
    );
  });

  it('passes through malformed URLs unchanged', () => {
    expect(rewriteUrlForContainer('not-a-url')).toBe('not-a-url');
  });

  it('handles https localhost', () => {
    expect(rewriteUrlForContainer('https://localhost:3200/mcp')).toBe(
      'https://host.docker.internal:3200/mcp',
    );
  });
});

// ---------------------------------------------------------------------------
// isRemoteEntry / classifyServerEntry
// ---------------------------------------------------------------------------
describe('classifyServerEntry', () => {
  it('classifies entry with url as remote', () => {
    const entry = { url: 'http://localhost:3200/mcp', tools: ['find'] };
    expect(classifyServerEntry(entry)).toBe('remote');
    expect(isRemoteEntry(entry)).toBe(true);
  });

  it('classifies entry with hostPath as stdio', () => {
    const entry = {
      hostPath: '/path/to/server',
      command: 'node',
      args: ['build/index.js'],
      tools: ['tool1'],
    };
    expect(classifyServerEntry(entry)).toBe('stdio');
    expect(isRemoteEntry(entry)).toBe(false);
  });

  it('rejects entry with both url and hostPath', () => {
    const entry = {
      url: 'http://localhost:3200/mcp',
      hostPath: '/path/to/server',
      command: 'node',
      args: ['build/index.js'],
      tools: ['find'],
    };
    expect(classifyServerEntry(entry)).toBe('invalid-both');
  });

  it('rejects entry with neither url nor hostPath', () => {
    const entry = { tools: ['find'] };
    expect(classifyServerEntry(entry)).toBe('invalid-neither');
  });
});

// ---------------------------------------------------------------------------
// assembleSkillContent (uses real filesystem with tmp dirs)
// ---------------------------------------------------------------------------
describe('assembleSkillContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips YAML frontmatter', () => {
    const skillPath = path.join(tmpDir, 'SKILL.md');
    fs.writeFileSync(
      skillPath,
      '---\nname: test\ndescription: Test skill\n---\n\n# MongoDB Tools\n\nUse find to query.',
    );
    const result = assembleSkillContent(skillPath);
    expect(result).toBe('# MongoDB Tools\n\nUse find to query.');
    expect(result).not.toContain('---');
  });

  it('inlines referenced .md files', () => {
    fs.mkdirSync(path.join(tmpDir, 'reference'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'SKILL.md'),
      '# MongoDB\n\nSee [Schema](reference/schema.md) for details.',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'reference', 'schema.md'),
      '## Collections\n\n- users\n- orders',
    );
    const result = assembleSkillContent(path.join(tmpDir, 'SKILL.md'));
    expect(result).toContain('# MongoDB');
    expect(result).toContain('### Schema');
    expect(result).toContain('## Collections');
    expect(result).toContain('- users');
  });

  it('returns undefined for empty file', () => {
    const skillPath = path.join(tmpDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '');
    const result = assembleSkillContent(skillPath);
    expect(result).toBeUndefined();
  });

  it('handles frontmatter-only file', () => {
    const skillPath = path.join(tmpDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: test\n---\n');
    const result = assembleSkillContent(skillPath);
    expect(result).toBeUndefined();
  });

  it('skips missing referenced files gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'SKILL.md'),
      '# Tools\n\nSee [Missing](reference/nonexistent.md) for details.',
    );
    const result = assembleSkillContent(path.join(tmpDir, 'SKILL.md'));
    expect(result).toBe(
      '# Tools\n\nSee [Missing](reference/nonexistent.md) for details.',
    );
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: flat tools array for remote entries
// ---------------------------------------------------------------------------
describe('backward compatibility', () => {
  it('remote entry with flat tools array registers all tools', () => {
    expect(resolveTools(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('access-level tools + readOnly registers only read tools', () => {
    const tools = {
      read: ['find', 'aggregate', 'count'],
      write: ['insert-many', 'update-many'],
      admin: ['delete-many', 'drop-collection'],
    };
    expect(resolveTools(tools, true)).toEqual(['find', 'aggregate', 'count']);
  });

  it('access-level tools without readOnly registers all levels', () => {
    const tools = {
      read: ['find', 'aggregate'],
      write: ['insert-many'],
    };
    expect(resolveTools(tools)).toEqual(['find', 'aggregate', 'insert-many']);
  });
});
