/**
 * Rate limiter for the credential proxy.
 *
 * Tracks Anthropic rate-limit headers from every response and queues
 * outgoing requests when capacity is low or a 429 is received.
 * Containers never see rate-limit errors — requests are held until
 * they can succeed.
 */
import { logger } from './logger.js';

export interface RateLimitState {
  /** Remaining requests in current window (from x-ratelimit-remaining-requests) */
  remainingRequests: number | null;
  /** Remaining tokens in current window (from x-ratelimit-remaining-tokens) */
  remainingTokens: number | null;
  /** Absolute time when request limit resets */
  requestsResetAt: number | null;
  /** Absolute time when token limit resets */
  tokensResetAt: number | null;
  /** If rate-limited (429), earliest time we can retry */
  retryAfter: number | null;
  /** Number of requests currently in-flight to upstream */
  inflight: number;
}

interface QueuedRequest {
  execute: () => void;
}

const RATE_LIMIT_BUFFER_REQUESTS = parseInt(
  process.env.RATE_LIMIT_BUFFER_REQUESTS || '2',
  10,
);

const MAX_PROXY_CONCURRENCY = parseInt(
  process.env.MAX_PROXY_CONCURRENCY || '5',
  10,
);

export class RateLimiter {
  private state: RateLimitState = {
    remainingRequests: null,
    remainingTokens: null,
    requestsResetAt: null,
    tokensResetAt: null,
    retryAfter: null,
    inflight: 0,
  };

  private queue: QueuedRequest[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Attempt to acquire a slot. Returns a promise that resolves when the
   * request is allowed to proceed.
   */
  acquire(): Promise<void> {
    if (this.canProceed()) {
      this.state.inflight++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ execute: resolve });
      this.scheduleDrain();
    });
  }

  /** Called when a request completes (success or failure). */
  release(): void {
    this.state.inflight = Math.max(0, this.state.inflight - 1);
    this.drain();
  }

  /**
   * Update state from Anthropic response headers.
   * Call this on every upstream response.
   */
  updateFromHeaders(
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const get = (name: string): string | undefined => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    // Parse remaining counts
    const remainReq = get('x-ratelimit-remaining-requests');
    if (remainReq !== undefined) {
      this.state.remainingRequests = parseInt(remainReq, 10);
    }

    const remainTok = get('x-ratelimit-remaining-tokens');
    if (remainTok !== undefined) {
      this.state.remainingTokens = parseInt(remainTok, 10);
    }

    // Parse reset times
    const resetReq = get('x-ratelimit-reset-requests');
    if (resetReq) {
      this.state.requestsResetAt = this.parseResetTime(resetReq);
    }

    const resetTok = get('x-ratelimit-reset-tokens');
    if (resetTok) {
      this.state.tokensResetAt = this.parseResetTime(resetTok);
    }

    // Handle 429
    if (statusCode === 429) {
      const retryAfter = get('retry-after');
      const retryMs = retryAfter ? parseFloat(retryAfter) * 1000 : 10_000; // default 10s if no header
      this.state.retryAfter = Date.now() + retryMs;

      logger.warn(
        {
          retryMs,
          queueLength: this.queue.length,
          inflight: this.state.inflight,
          remainingRequests: this.state.remainingRequests,
        },
        'Rate limited (429), queuing requests',
      );

      this.scheduleDrain();
    } else {
      // Clear retry-after on successful responses
      this.state.retryAfter = null;
    }

    logger.debug(
      {
        remainingRequests: this.state.remainingRequests,
        remainingTokens: this.state.remainingTokens,
        inflight: this.state.inflight,
        queued: this.queue.length,
      },
      'Rate limit state updated',
    );
  }

  /** Whether the request that triggered a 429 should be retried by the proxy. */
  shouldRetry(statusCode: number): boolean {
    return statusCode === 429;
  }

  /** How long to wait before retrying a 429'd request (ms). */
  getRetryDelay(): number {
    if (this.state.retryAfter) {
      return Math.max(0, this.state.retryAfter - Date.now());
    }
    return 10_000;
  }

  getState(): Readonly<RateLimitState> {
    return { ...this.state };
  }

  private canProceed(): boolean {
    const now = Date.now();

    // Hard block: we got a 429 and haven't waited long enough
    if (this.state.retryAfter && now < this.state.retryAfter) {
      return false;
    }

    // Concurrency limit
    if (this.state.inflight >= MAX_PROXY_CONCURRENCY) {
      return false;
    }

    // Proactive throttle: if we know remaining requests, hold back when low
    if (
      this.state.remainingRequests !== null &&
      this.state.remainingRequests <= RATE_LIMIT_BUFFER_REQUESTS &&
      this.state.requestsResetAt &&
      now < this.state.requestsResetAt
    ) {
      return false;
    }

    return true;
  }

  private drain(): void {
    while (this.queue.length > 0 && this.canProceed()) {
      const next = this.queue.shift()!;
      this.state.inflight++;
      next.execute();
    }

    // If there are still queued requests, schedule another drain
    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;

    let delayMs = 1000; // default poll interval

    const now = Date.now();
    if (this.state.retryAfter && this.state.retryAfter > now) {
      delayMs = this.state.retryAfter - now + 100; // small buffer
    } else if (this.state.requestsResetAt && this.state.requestsResetAt > now) {
      delayMs = Math.min(delayMs, this.state.requestsResetAt - now + 100);
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, delayMs);
  }

  /**
   * Parse reset time from Anthropic headers.
   * Can be an ISO 8601 timestamp or a duration like "1s", "500ms".
   */
  private parseResetTime(value: string): number {
    // Try ISO date first
    const date = Date.parse(value);
    if (!isNaN(date)) return date;

    // Try duration format (e.g. "1s", "500ms", "1m30s")
    let ms = 0;
    const minuteMatch = value.match(/(\d+)m(?!s)/);
    const secMatch = value.match(/(\d+(?:\.\d+)?)s/);
    const msMatch = value.match(/(\d+)ms/);

    if (minuteMatch) ms += parseInt(minuteMatch[1], 10) * 60_000;
    if (secMatch) ms += parseFloat(secMatch[1]) * 1000;
    if (msMatch) ms += parseInt(msMatch[1], 10);

    if (ms > 0) return Date.now() + ms;

    // Fallback: treat as seconds
    const num = parseFloat(value);
    if (!isNaN(num)) return Date.now() + num * 1000;

    return Date.now() + 10_000; // safe default
  }
}
