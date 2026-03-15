/**
 * Converts markdown text to Slack Block Kit payload using universally
 * supported section blocks with mrkdwn formatting.
 *
 * Key conversions from standard markdown to Slack mrkdwn:
 * - **bold** → *bold*
 * - ## Headings → *Headings* (bold)
 * - [text](url) → <url|text>
 * - Markdown tables → preformatted code blocks (monospace alignment)
 */

import type { KnownBlock, SectionBlock, HeaderBlock } from '@slack/types';

// Section block text limit is 3000 characters.
const MAX_SECTION_TEXT = 3000;

// Slack allows a maximum of 50 blocks per message.
const MAX_BLOCKS = 50;

/**
 * Build a Slack `chat.postMessage` payload from markdown text.
 */
export function markdownToSlackPayload(text: string): {
  blocks: KnownBlock[];
  text: string; // plain-text fallback for notifications
} {
  const fallback = text.slice(0, 4000);
  const blocks = markdownToBlocks(text);

  return { blocks, text: fallback };
}

/**
 * Convert markdown text into an array of Slack Block Kit blocks.
 */
export function markdownToBlocks(text: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const sections = splitIntoSections(text);

  for (const section of sections) {
    if (blocks.length >= MAX_BLOCKS) break;

    if (section.type === 'heading') {
      // Use header block for h1/h2, bold section for h3+
      if (section.level && section.level <= 2) {
        blocks.push({
          type: 'header',
          text: {
            type: 'plain_text',
            text: section.content.slice(0, 150),
            emoji: true,
          },
        } as HeaderBlock);
      } else {
        blocks.push(makeSectionBlock(`*${convertInlineFormatting(section.content)}*`));
      }
    } else if (section.type === 'table') {
      blocks.push(makeSectionBlock(tableToCodeBlock(section.content)));
    } else if (section.type === 'code') {
      blocks.push(makeSectionBlock(section.content));
    } else {
      // Regular paragraph — convert inline formatting
      const converted = convertInlineFormatting(section.content);
      // Split into multiple section blocks if too long
      const chunks = splitText(converted, MAX_SECTION_TEXT);
      for (const chunk of chunks) {
        if (blocks.length >= MAX_BLOCKS) break;
        blocks.push(makeSectionBlock(chunk));
      }
    }
  }

  return blocks;
}

interface Section {
  type: 'paragraph' | 'heading' | 'table' | 'code';
  content: string;
  level?: number; // heading level
}

/**
 * Parse markdown text into logical sections (paragraphs, headings, tables, code blocks).
 */
export function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith('```')) {
      const codeLines = [line];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        codeLines.push(lines[i]); // closing ```
        i++;
      }
      sections.push({ type: 'code', content: codeLines.join('\n') });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      sections.push({
        type: 'heading',
        content: headingMatch[2],
        level: headingMatch[1].length,
      });
      i++;
      continue;
    }

    // Table (line contains | and next line is separator row or this is a separator)
    if (isTableLine(line)) {
      const tableLines = [];
      while (i < lines.length && isTableLine(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      sections.push({ type: 'table', content: tableLines.join('\n') });
      continue;
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph — collect consecutive non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].trimStart().startsWith('```') &&
      !isTableLine(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      sections.push({ type: 'paragraph', content: paraLines.join('\n') });
    }
  }

  return sections;
}

function isTableLine(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  return trimmed.includes('|') && (trimmed.startsWith('|') || /^\S+\s*\|/.test(trimmed));
}

/**
 * Convert a markdown table into a preformatted code block for monospace alignment.
 */
export function tableToCodeBlock(tableText: string): string {
  const lines = tableText.split('\n').filter((l) => l.trim());
  // Strip separator rows (|---|---|)
  const dataLines = lines.filter((l) => !l.match(/^\|?\s*[-:]+[-|\s:]*$/));

  if (dataLines.length === 0) return '```\n(empty table)\n```';

  // Parse cells
  const rows = dataLines.map((line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim()),
  );

  // Calculate column widths
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], (row[c] || '').length);
    }
  }

  // Format aligned rows
  const formatted = rows.map((row) =>
    row.map((cell, c) => cell.padEnd(widths[c])).join('  '),
  );

  // Add a separator after the header row
  if (formatted.length > 1) {
    const sep = widths.map((w) => '-'.repeat(w)).join('  ');
    formatted.splice(1, 0, sep);
  }

  return '```\n' + formatted.join('\n') + '\n```';
}

/**
 * Convert markdown inline formatting to Slack mrkdwn.
 */
export function convertInlineFormatting(text: string): string {
  let result = text;

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Bold: **text** → *text* (Slack uses single asterisks for bold)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Blockquotes: > text → > text (same in Slack, but ensure single >)
  result = result.replace(/^>\s?/gm, '> ');

  return result;
}

function makeSectionBlock(text: string): SectionBlock {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: text.slice(0, MAX_SECTION_TEXT),
    },
  };
}

/**
 * Split text into chunks fitting within maxLen, preferring line boundaries.
 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}
