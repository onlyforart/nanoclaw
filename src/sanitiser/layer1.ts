/**
 * Sanitiser Layer 1 — deterministic pre-processing.
 * Zero injection surface. All extraction is regex, structural parsing, and metadata.
 */

export interface Layer1Input {
  raw_text: string;
  sender_id: string;
  channel_id: string;
  thread_ts?: string;
  is_bot_message: boolean;
  timestamp: string;
  subtype?: string;
}

export interface Layer1Output {
  sender_id: string;
  channel_id: string;
  thread_ts: string | null;
  timestamp: string;

  referenced_tickets: Array<{ id: string; system: string }>;
  inc_present: boolean;
  code_blocks: Array<{ kind: string; content: string }>;
  links: Array<{ url: string; is_internal: boolean }>;
  mentions: Array<{ user_id: string; is_bot_address: boolean }>;
  is_channel_join: boolean;
  is_bot_message: boolean;
  message_length: number;

  processed_text: string;
  filtered: boolean;
  filter_reason?: string;
}

export interface TicketPattern {
  pattern: string;
  system: string;
}

// --- Default config ---

const DEFAULT_TICKET_PATTERNS: TicketPattern[] = [
  { pattern: 'INC\\d+', system: 'servicenow' },
  { pattern: 'CHG\\d+', system: 'servicenow' },
  { pattern: 'RITM\\d+', system: 'servicenow' },
];

const DEFAULT_INTERNAL_PATTERNS = [/\.internal\./, /\.corp\./];
const DEFAULT_BOT_USER_IDS: string[] = [];
const DEFAULT_MAX_TEXT_LENGTH = 2000;

// --- Extraction functions ---

export function extractTicketReferences(
  text: string,
  patterns: TicketPattern[],
): Array<{ id: string; system: string }> {
  const seen = new Set<string>();
  const results: Array<{ id: string; system: string }> = [];

  for (const { pattern, system } of patterns) {
    const regex = new RegExp(pattern, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      const id = match[0];
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ id, system });
      }
    }
  }

  return results;
}

export function extractCodeBlocks(
  text: string,
): Array<{ kind: string; content: string }> {
  const blocks: Array<{ kind: string; content: string }> = [];
  const regex = /```(?:\w*)\n?([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content) {
      blocks.push({ kind: classifyCodeBlock(content), content });
    }
  }

  return blocks;
}

export function classifyCodeBlock(content: string): string {
  // JSON
  if (/^\s*[\[{]/.test(content) && /[\]}]\s*$/.test(content)) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      // Not valid JSON, continue
    }
  }

  // Stack trace
  if (/^\s*(Error|TypeError|ReferenceError|SyntaxError|Exception|Traceback)/m.test(content) || /\s+at\s+\S+\s+\(/.test(content)) {
    return 'stack_trace';
  }

  // HTTP request
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\//m.test(content)) {
    return 'http_request';
  }

  // Log lines (timestamps at start of lines)
  if (/^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/m.test(content)) {
    return 'log';
  }

  return 'other';
}

export function extractLinks(
  text: string,
  internalPatterns: RegExp[],
): Array<{ url: string; is_internal: boolean }> {
  const regex = /https?:\/\/[^\s<>)}\]]+/g;
  const results: Array<{ url: string; is_internal: boolean }> = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const url = match[0];
    const is_internal = internalPatterns.some((p) => p.test(url));
    results.push({ url, is_internal });
  }

  return results;
}

export function extractMentions(
  text: string,
  botUserIds: string[],
): Array<{ user_id: string; is_bot_address: boolean }> {
  const regex = /<@(\w+)>/g;
  const results: Array<{ user_id: string; is_bot_address: boolean }> = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const user_id = match[1];
    results.push({
      user_id,
      is_bot_address: botUserIds.includes(user_id),
    });
  }

  return results;
}

export function redactPII(text: string): string {
  // Email addresses
  let result = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[REDACTED_EMAIL]',
  );

  // Phone numbers (international format, various separators)
  result = result.replace(
    /\+?\d[\d\s\-()]{7,}\d/g,
    '[REDACTED_PHONE]',
  );

  return result;
}

export function truncateForLLM(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '[TRUNCATED]';
}

// --- Main pre-processor ---

export function preprocessMessage(
  input: Layer1Input,
  config?: {
    ticketPatterns?: TicketPattern[];
    internalUrlPatterns?: RegExp[];
    botUserIds?: string[];
    maxTextLength?: number;
  },
): Layer1Output {
  const ticketPatterns = config?.ticketPatterns ?? DEFAULT_TICKET_PATTERNS;
  const internalPatterns = config?.internalUrlPatterns ?? DEFAULT_INTERNAL_PATTERNS;
  const botUserIds = config?.botUserIds ?? DEFAULT_BOT_USER_IDS;
  const maxTextLength = config?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  // Check for filtered message types
  const is_channel_join = input.subtype === 'channel_join';
  if (is_channel_join) {
    return {
      sender_id: input.sender_id,
      channel_id: input.channel_id,
      thread_ts: input.thread_ts ?? null,
      timestamp: input.timestamp,
      referenced_tickets: [],
      inc_present: false,
      code_blocks: [],
      links: [],
      mentions: [],
      is_channel_join: true,
      is_bot_message: input.is_bot_message,
      message_length: input.raw_text.length,
      processed_text: '',
      filtered: true,
      filter_reason: 'channel_join',
    };
  }

  const referenced_tickets = extractTicketReferences(input.raw_text, ticketPatterns);
  const code_blocks = extractCodeBlocks(input.raw_text);
  const links = extractLinks(input.raw_text, internalPatterns);
  const mentions = extractMentions(input.raw_text, botUserIds);

  // Build processed text: redact PII, replace code blocks with placeholders, truncate
  let processedText = input.raw_text;

  // Replace code blocks with placeholders
  for (let i = 0; i < code_blocks.length; i++) {
    processedText = processedText.replace(
      new RegExp('```(?:\\w*\\n?)?' + escapeRegex(code_blocks[i].content) + '\\s*```'),
      `[CODE_BLOCK_${i + 1}:${code_blocks[i].kind}]`,
    );
  }

  processedText = redactPII(processedText);
  processedText = truncateForLLM(processedText, maxTextLength);

  return {
    sender_id: input.sender_id,
    channel_id: input.channel_id,
    thread_ts: input.thread_ts ?? null,
    timestamp: input.timestamp,
    referenced_tickets,
    inc_present: referenced_tickets.some((t) => t.id.startsWith('INC')),
    code_blocks,
    links,
    mentions,
    is_channel_join: false,
    is_bot_message: input.is_bot_message,
    message_length: input.raw_text.length,
    processed_text: processedText,
    filtered: false,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
