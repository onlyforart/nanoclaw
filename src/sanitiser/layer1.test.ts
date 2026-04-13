import { describe, it, expect } from 'vitest';

import {
  extractTicketReferences,
  extractCodeBlocks,
  classifyCodeBlock,
  extractLinks,
  extractMentions,
  redactPII,
  truncateForLLM,
  preprocessMessage,
  type Layer1Input,
} from './layer1.js';

const DEFAULT_TICKET_PATTERNS = [
  { pattern: 'INC\\d+', system: 'servicenow' },
  { pattern: 'CHG\\d+', system: 'servicenow' },
  { pattern: 'RITM\\d+', system: 'servicenow' },
];

// --- extractTicketReferences ---

describe('extractTicketReferences', () => {
  it('extracts INC ticket references', () => {
    const refs = extractTicketReferences(
      'INC12345 is causing issues',
      DEFAULT_TICKET_PATTERNS,
    );
    expect(refs).toEqual([{ id: 'INC12345', system: 'servicenow' }]);
  });

  it('extracts multiple ticket types', () => {
    const refs = extractTicketReferences(
      'INC12345 related to CHG67890',
      DEFAULT_TICKET_PATTERNS,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0].id).toBe('INC12345');
    expect(refs[1].id).toBe('CHG67890');
  });

  it('extracts RITM references', () => {
    const refs = extractTicketReferences(
      'RITM001234 pending approval',
      DEFAULT_TICKET_PATTERNS,
    );
    expect(refs).toEqual([{ id: 'RITM001234', system: 'servicenow' }]);
  });

  it('returns empty array when no tickets found', () => {
    expect(
      extractTicketReferences('no tickets here', DEFAULT_TICKET_PATTERNS),
    ).toEqual([]);
  });

  it('deduplicates repeated ticket IDs', () => {
    const refs = extractTicketReferences(
      'INC123 mentioned INC123 again',
      DEFAULT_TICKET_PATTERNS,
    );
    expect(refs).toHaveLength(1);
  });

  it('supports configurable JIRA patterns', () => {
    const patterns = [
      ...DEFAULT_TICKET_PATTERNS,
      { pattern: 'PROJ-\\d+', system: 'jira' },
    ];
    const refs = extractTicketReferences('PROJ-456 and INC789', patterns);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.system === 'jira')!.id).toBe('PROJ-456');
  });
});

// --- extractCodeBlocks ---

describe('extractCodeBlocks', () => {
  it('extracts fenced code blocks', () => {
    const text = 'before\n```\nsome code\n```\nafter';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('some code');
  });

  it('extracts multiple code blocks', () => {
    const text = '```\nblock1\n```\ntext\n```\nblock2\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(2);
  });

  it('extracts code blocks with language hint', () => {
    const text = '```json\n{"key": "value"}\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('{"key": "value"}');
  });

  it('returns empty array when no code blocks', () => {
    expect(extractCodeBlocks('just plain text')).toEqual([]);
  });
});

// --- classifyCodeBlock ---

describe('classifyCodeBlock', () => {
  it('classifies JSON', () => {
    expect(classifyCodeBlock('{"error": "not found"}')).toBe('json');
  });

  it('classifies stack traces', () => {
    expect(
      classifyCodeBlock(
        'Error: something failed\n  at Object.<anonymous> (/app/index.js:10:5)\n  at Module._compile',
      ),
    ).toBe('stack_trace');
  });

  it('classifies log lines', () => {
    expect(
      classifyCodeBlock(
        '[2024-01-01T10:00:00Z] ERROR: connection refused\n[2024-01-01T10:00:01Z] WARN: retrying',
      ),
    ).toBe('log');
  });

  it('classifies HTTP requests', () => {
    expect(
      classifyCodeBlock('GET /api/v1/users HTTP/1.1\nHost: example.com'),
    ).toBe('http_request');
  });

  it('returns other for unrecognised content', () => {
    expect(classifyCodeBlock('random stuff')).toBe('other');
  });
});

// --- extractLinks ---

describe('extractLinks', () => {
  it('extracts URLs', () => {
    const links = extractLinks('check https://example.com/status', []);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/status');
    expect(links[0].is_internal).toBe(false);
  });

  it('flags internal URLs', () => {
    const links = extractLinks(
      'see https://dashboard.internal.company.com/grafana',
      [/\.internal\./],
    );
    expect(links[0].is_internal).toBe(true);
  });

  it('extracts multiple links', () => {
    const links = extractLinks('http://a.com and https://b.com', []);
    expect(links).toHaveLength(2);
  });

  it('returns empty array when no links', () => {
    expect(extractLinks('no links here', [])).toEqual([]);
  });
});

// --- extractMentions ---

describe('extractMentions', () => {
  it('extracts Slack-style mentions', () => {
    const mentions = extractMentions('<@U123ABC> can you check?', []);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].user_id).toBe('U123ABC');
    expect(mentions[0].is_bot_address).toBe(false);
  });

  it('flags bot address when user ID is in bot list', () => {
    const mentions = extractMentions('<@UBOTID> restart please', ['UBOTID']);
    expect(mentions[0].is_bot_address).toBe(true);
  });

  it('extracts multiple mentions', () => {
    const mentions = extractMentions('<@U111> and <@U222>', []);
    expect(mentions).toHaveLength(2);
  });

  it('returns empty for no mentions', () => {
    expect(extractMentions('no mentions', [])).toEqual([]);
  });
});

// --- redactPII ---

describe('redactPII', () => {
  it('redacts email addresses', () => {
    const result = redactPII('contact alice@example.com for help');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('alice@example.com');
  });

  it('redacts phone numbers', () => {
    const result = redactPII('call +1 (555) 123-4567');
    expect(result).toContain('[REDACTED_PHONE]');
  });

  it('does not redact ticket IDs', () => {
    const result = redactPII('INC12345 is open');
    expect(result).toContain('INC12345');
  });

  it('handles text with no PII', () => {
    const text = 'the server is down';
    expect(redactPII(text)).toBe(text);
  });
});

// --- truncateForLLM ---

describe('truncateForLLM', () => {
  it('leaves short text unchanged', () => {
    expect(truncateForLLM('short', 100)).toBe('short');
  });

  it('truncates long text and adds marker', () => {
    const long = 'x'.repeat(200);
    const result = truncateForLLM(long, 100);
    expect(result.length).toBeLessThanOrEqual(100 + '[TRUNCATED]'.length);
    expect(result).toContain('[TRUNCATED]');
  });

  it('handles exact limit', () => {
    const exact = 'x'.repeat(100);
    expect(truncateForLLM(exact, 100)).toBe(exact);
  });
});

// --- preprocessMessage ---

describe('preprocessMessage', () => {
  const baseInput: Layer1Input = {
    raw_text:
      'INC12345 is down, see https://grafana.internal.co/d/abc for details',
    sender_id: 'U123',
    channel_id: 'C456',
    timestamp: '2024-06-01T10:00:00.000Z',
    is_bot_message: false,
  };

  it('extracts tickets and sets inc_present', () => {
    const output = preprocessMessage(baseInput);
    expect(output.referenced_tickets).toHaveLength(1);
    expect(output.referenced_tickets[0].id).toBe('INC12345');
    expect(output.inc_present).toBe(true);
  });

  it('passes through metadata', () => {
    const output = preprocessMessage(baseInput);
    expect(output.sender_id).toBe('U123');
    expect(output.channel_id).toBe('C456');
    expect(output.timestamp).toBe('2024-06-01T10:00:00.000Z');
  });

  it('filters channel join messages', () => {
    const output = preprocessMessage({
      ...baseInput,
      subtype: 'channel_join',
      raw_text: 'user joined',
    });
    expect(output.filtered).toBe(true);
    expect(output.filter_reason).toContain('channel_join');
  });

  it('marks bot messages', () => {
    const output = preprocessMessage({ ...baseInput, is_bot_message: true });
    expect(output.is_bot_message).toBe(true);
  });

  it('sets message_length', () => {
    const output = preprocessMessage(baseInput);
    expect(output.message_length).toBe(baseInput.raw_text.length);
  });

  it('produces processed_text with PII redacted', () => {
    const input = {
      ...baseInput,
      raw_text: 'email alice@example.com about INC123',
    };
    const output = preprocessMessage(input);
    expect(output.processed_text).toContain('[REDACTED_EMAIL]');
    expect(output.processed_text).toContain('INC123');
  });
});
