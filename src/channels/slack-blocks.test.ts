import { describe, it, expect } from 'vitest';
import {
  markdownToSlackPayload,
  markdownToBlocks,
  splitIntoSections,
  tableToCodeBlock,
  convertInlineFormatting,
} from './slack-blocks.js';

describe('markdownToSlackPayload', () => {
  it('returns blocks and plain-text fallback', () => {
    const result = markdownToSlackPayload('Hello world');
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.text).toBe('Hello world');
  });

  it('provides fallback truncated to 4000 chars', () => {
    const text = 'X'.repeat(5000);
    const result = markdownToSlackPayload(text);
    expect(result.text).toBe('X'.repeat(4000));
  });
});

describe('markdownToBlocks', () => {
  it('converts plain text to a section block', () => {
    const blocks = markdownToBlocks('Hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn', text: 'Hello world' },
    });
  });

  it('converts h1/h2 headings to header blocks', () => {
    const blocks = markdownToBlocks('## My Heading');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'header',
      text: { type: 'plain_text', text: 'My Heading' },
    });
  });

  it('converts h3+ headings to bold section blocks', () => {
    const blocks = markdownToBlocks('### Sub Heading');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Sub Heading*' },
    });
  });

  it('converts markdown tables to code blocks', () => {
    const md = '| Name | Value |\n|------|-------|\n| A | 1 |\n| B | 2 |';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
    });
    const text = (blocks[0] as any).text.text;
    expect(text).toContain('```');
    expect(text).toContain('Name');
    expect(text).toContain('Value');
  });

  it('preserves code blocks as-is', () => {
    const md = '```js\nconsole.log("hi");\n```';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text.text).toContain('console.log');
  });

  it('handles mixed content', () => {
    const md = '## Title\n\nSome text.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nMore text.';
    const blocks = markdownToBlocks(md);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].type).toBe('header');
  });

  it('respects 50-block limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `## Heading ${i}\n\nPara ${i}`).join('\n\n');
    const blocks = markdownToBlocks(lines);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });
});

describe('splitIntoSections', () => {
  it('separates headings from paragraphs', () => {
    const sections = splitIntoSections('## Title\n\nHello world');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ type: 'heading', content: 'Title', level: 2 });
    expect(sections[1]).toMatchObject({ type: 'paragraph', content: 'Hello world' });
  });

  it('detects tables', () => {
    const sections = splitIntoSections('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('table');
  });

  it('detects code blocks', () => {
    const sections = splitIntoSections('```\ncode here\n```');
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('code');
  });

  it('handles consecutive paragraphs separated by blank lines', () => {
    const sections = splitIntoSections('First para\n\nSecond para');
    expect(sections).toHaveLength(2);
  });
});

describe('tableToCodeBlock', () => {
  it('converts table to aligned monospace code block', () => {
    const table = '| Name | Value |\n|------|-------|\n| A | 1 |\n| BB | 22 |';
    const result = tableToCodeBlock(table);
    expect(result).toMatch(/^```\n/);
    expect(result).toMatch(/\n```$/);
    // Separator rows should be stripped and replaced with dashes
    expect(result).not.toContain('|');
    expect(result).toContain('Name');
    expect(result).toContain('BB');
  });

  it('strips markdown separator rows', () => {
    const table = '| H1 | H2 |\n|:---|---:|\n| a | b |';
    const result = tableToCodeBlock(table);
    expect(result).not.toMatch(/[-:]{3,}/);
    // Should have header, separator (dashes), and data row
    const lines = result.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(5); // ```, header, sep, data, ```
  });
});

describe('convertInlineFormatting', () => {
  it('converts **bold** to *bold*', () => {
    expect(convertInlineFormatting('**hello**')).toBe('*hello*');
  });

  it('converts [text](url) to <url|text>', () => {
    expect(convertInlineFormatting('[click](https://example.com)')).toBe(
      '<https://example.com|click>',
    );
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(convertInlineFormatting('~~deleted~~')).toBe('~deleted~');
  });

  it('leaves single asterisks (italic/bold) unchanged', () => {
    expect(convertInlineFormatting('*already bold*')).toBe('*already bold*');
  });

  it('handles mixed formatting', () => {
    const input = '**bold** and _italic_ and [link](http://x.com)';
    const result = convertInlineFormatting(input);
    expect(result).toBe('*bold* and _italic_ and <http://x.com|link>');
  });
});
