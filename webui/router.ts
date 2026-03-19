import type { IncomingMessage } from 'node:http';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export interface CompiledRoute {
  pattern: RegExp;
  keys: string[];
}

export function compilePath(path: string): CompiledRoute {
  const keys: string[] = [];
  const parts = path.split('/').map((part) => {
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      return '([^/]+)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const pattern = new RegExp(`^${parts.join('/')}$`);
  return { pattern, keys };
}

export function matchPath(
  route: CompiledRoute,
  url: string,
): Record<string, string> | null {
  const match = route.pattern.exec(url);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.keys.length; i++) {
    params[route.keys[i]] = decodeURIComponent(match[i + 1]);
  }
  return params;
}

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const qs = url.slice(idx + 1);
  const params: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      params[decodeURIComponent(pair)] = '';
    } else {
      params[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(
        pair.slice(eqIdx + 1),
      );
    }
  }
  return params;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return reject(new HttpError(400, 'Content-Type must be application/json'));
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new HttpError(413, 'Request body too large'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        return reject(new HttpError(400, 'Empty request body'));
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Malformed JSON'));
      }
    });

    req.on('error', reject);
  });
}
