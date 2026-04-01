/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Rate limiting: All requests are queued through a RateLimiter that tracks
 * Anthropic's rate-limit headers. When capacity is low or a 429 is received,
 * requests are held (not dropped) until they can succeed. Containers never
 * see rate-limit errors.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RateLimiter } from './rate-limiter.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const MAX_429_RETRIES = 3;
const UPSTREAM_TIMEOUT_MS = 60_000; // 60s — abort if upstream doesn't respond
const ACQUIRE_TIMEOUT_MS = 120_000; // 120s — give up waiting for a rate-limiter slot

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const rateLimiter = new RateLimiter();

  function buildHeaders(
    req: IncomingMessage,
    body: Buffer,
  ): Record<string, string | number | string[] | undefined> {
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: upstreamUrl.host,
      'content-length': body.length,
    };

    // Strip hop-by-hop headers that must not be forwarded by proxies
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (authMode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
    } else {
      if (headers['authorization']) {
        delete headers['authorization'];
        if (oauthToken) {
          headers['authorization'] = `Bearer ${oauthToken}`;
        }
      }
    }

    return headers;
  }

  function sendUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    headers: Record<string, string | number | string[] | undefined>,
    attempt: number,
  ): void {
    const upstream = makeRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        const statusCode = upRes.statusCode!;
        const upHeaders = upRes.headers as Record<
          string,
          string | string[] | undefined
        >;

        // Update rate limiter from every response
        rateLimiter.updateFromHeaders(statusCode, upHeaders);

        // On 429, buffer the response body and retry transparently
        if (rateLimiter.shouldRetry(statusCode) && attempt < MAX_429_RETRIES) {
          // Consume the response body so the socket is freed
          const discardChunks: Buffer[] = [];
          upRes.on('data', (c) => discardChunks.push(c));
          upRes.on('end', () => {
            const retryDelay = rateLimiter.getRetryDelay();
            logger.info(
              {
                url: req.url,
                attempt: attempt + 1,
                retryDelay,
                ...rateLimiter.getState(),
              },
              'Retrying rate-limited request',
            );
            setTimeout(async () => {
              try {
                await rateLimiter.acquire();
                sendUpstream(req, res, body, headers, attempt + 1);
              } catch {
                rateLimiter.release();
                if (!res.headersSent) {
                  res.writeHead(503);
                  res.end('Service Unavailable');
                }
              }
            }, retryDelay);
          });
          // Release the current slot — the retry will acquire a new one
          rateLimiter.release();
          return;
        }

        // Forward response to container
        res.writeHead(statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => rateLimiter.release());
      },
    );

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
    });

    upstream.on('error', (err) => {
      rateLimiter.release();
      logger.error({ err, url: req.url }, 'Credential proxy upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers = buildHeaders(req, body);

        try {
          // Wait for rate limiter to grant a slot (with timeout)
          await Promise.race([
            rateLimiter.acquire(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(
                `Rate limiter acquire timeout after ${ACQUIRE_TIMEOUT_MS}ms (inflight: ${rateLimiter.getState().inflight}, queued: ${rateLimiter.getState().queued ?? '?'})`,
              )), ACQUIRE_TIMEOUT_MS),
            ),
          ]);
          sendUpstream(req, res, body, headers, 0);
        } catch (err) {
          logger.error({ err, url: req.url }, 'Credential proxy request failed');
          if (!res.headersSent) {
            res.writeHead(503);
            res.end('Service Unavailable');
          }
        }
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode },
        'Credential proxy started (with rate limiting)',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
