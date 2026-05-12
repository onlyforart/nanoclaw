/**
 * Tests for src/mcp-auth-proxy.ts.
 *
 * Encodes the role spec — HTTP reverse proxy that intercepts MCP
 * `tools/call` requests, evaluates them against per-group policies,
 * and forwards allowed traffic to the upstream MCP server.
 *
 * These are integration tests against a real http listener (cheap
 * — `port: 0` picks any free port) plus a fake upstream that
 * records the requests it receives. That way we exercise the
 * actual request/response shaping, header propagation, and the
 * JSON-RPC error envelope rather than mocking the http module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

import { startMcpAuthProxy, type McpAuthProxyConfig } from './mcp-auth-proxy.js';
import type { PolicyRule, PolicySet, PolicyAssignments } from './mcp-policy.js';

// =============================================================================
// Fake upstream MCP server — records requests, returns canned responses
// =============================================================================

interface UpstreamHandle {
  url: string;
  requests: Array<{
    method: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  close: () => Promise<void>;
}

async function startFakeUpstream(
  responder: (req: IncomingMessage, body: string, res: ServerResponse) => void = (req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { received: body } }));
  },
): Promise<UpstreamHandle> {
  const requests: UpstreamHandle['requests'] = [];

  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', headers: req.headers, body: data });
      responder(req, data, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// =============================================================================
// Policy fixtures
// =============================================================================

function buildPolicySet(map: Record<string, Record<string, PolicyRule>>): PolicySet {
  const policies = new Map<string, Map<string, PolicyRule>>();
  for (const [server, tiers] of Object.entries(map)) {
    const tierMap = new Map<string, PolicyRule>();
    for (const [name, rule] of Object.entries(tiers)) tierMap.set(name, rule);
    policies.set(server, tierMap);
  }
  return { policies };
}

function makeAssignments(tier: string, perGroup: Record<string, string> = {}): PolicyAssignments {
  return { defaultTier: tier, groups: perGroup };
}

// =============================================================================
// Lifecycle helpers
// =============================================================================

let proxy: { server: Server; port: number } | null = null;
let upstream: UpstreamHandle | null = null;

async function startProxy(config: McpAuthProxyConfig): Promise<string> {
  proxy = await startMcpAuthProxy(0, '127.0.0.1', config);
  return `http://127.0.0.1:${proxy.port}`;
}

afterEach(async () => {
  if (proxy) {
    await new Promise<void>((resolve, reject) => proxy!.server.close((err) => (err ? reject(err) : resolve())));
    proxy = null;
  }
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
});

// =============================================================================
// startMcpAuthProxy — listener + URL routing
// =============================================================================

describe('startMcpAuthProxy', () => {
  it('returns the actual port when port=0 is requested', async () => {
    upstream = await startFakeUpstream();
    proxy = await startMcpAuthProxy(0, '127.0.0.1', {
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({}),
      assignments: new Map(),
    });

    expect(proxy.port).toBeGreaterThan(0);
    expect(typeof proxy.server.listen).toBe('function');
  });
});

describe('mcp-auth-proxy — request routing (preconditions)', () => {
  it('returns 400 "Missing server name" for the root path', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({}),
      assignments: new Map(),
    });

    const res = await fetch(proxyUrl, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Missing server name/);
  });

  it('returns 404 "Unknown server" for an unregistered upstream name', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({}),
      assignments: new Map(),
    });

    const res = await fetch(`${proxyUrl}/missing`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Unknown server: missing/);
  });

  it('returns 400 "Invalid JSON body" when the body is not parseable', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({}),
      assignments: new Map(),
    });

    const res = await fetch(`${proxyUrl}/srv`, { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Invalid JSON/);
  });
});

describe('mcp-auth-proxy — non tools/call methods (passthrough)', () => {
  it('forwards "initialize" verbatim to upstream without checking policy or group header', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({}), // no policies — would normally block tools/call
      assignments: new Map(),
    });

    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initBody,
    });

    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body).toBe(initBody);
  });
});

describe('mcp-auth-proxy — tools/call gate', () => {
  function rule(allow: string[]): PolicyRule {
    return { tools: { allow } };
  }

  it('returns 400 "Missing X-NanoClaw-Group" header when the group is absent', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: rule(['fetch']) } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch', arguments: {} } }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/X-NanoClaw-Group/);
  });

  it('returns MCP error envelope when no assignments registered for that server', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: rule(['fetch']) } }),
      assignments: new Map(),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fetch' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      jsonrpc: string;
      id: number | null;
      error: { code: number; message: string };
    };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(7);
    expect(json.error.code).toBe(-32600);
    expect(json.error.message).toMatch(/No policy assignments/);
  });

  it('returns MCP error envelope when no policy tier resolves for the group', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { onlyTier: rule(['fetch']) } }),
      // No defaultTier and no group-specific tier → resolveTier returns null.
      assignments: new Map([['srv', { groups: {} } as PolicyAssignments]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch' } }),
    });
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/No policy tier found.*g1/);
  });

  it('denies tools/call when policy disallows the tool', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: rule(['fetch']) } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: {} } }),
    });
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/Access denied/);
    // Upstream must not have received the denied request.
    expect(upstream.requests).toHaveLength(0);
  });

  it('forwards tools/call to upstream when policy allows', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: rule(['fetch']) } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fetch', arguments: { url: 'x' } },
    });
    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body,
    });

    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body).toBe(body);
  });

  it('per-group assignment overrides defaultTier', async () => {
    const restrictedRule: PolicyRule = { tools: { allow: ['read'] } };
    const adminRule: PolicyRule = { tools: { allow: ['*'] } };

    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { restricted: restrictedRule, admin: adminRule } }),
      assignments: new Map([['srv', makeAssignments('restricted', { admins: 'admin' })]]),
    });

    // restricted group: cannot call "delete"
    const res1 = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'untrusted' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete' } }),
    });
    expect(((await res1.json()) as { error: { message: string } }).error.message).toMatch(/Access denied/);
    expect(upstream.requests).toHaveLength(0);

    // admin group: can call anything
    const res2 = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'admins' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete' } }),
    });
    expect(res2.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });
});

describe('mcp-auth-proxy — JSON-RPC error envelope', () => {
  it('preserves the request id', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: { tools: { allow: ['fetch'] } } } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'string-id', method: 'tools/call', params: { name: 'denied' } }),
    });
    const json = (await res.json()) as { id: string | null };
    expect(json.id).toBe('string-id');
  });

  it('returns id=null when the request id is missing', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: { tools: { allow: ['fetch'] } } } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'denied' } }),
    });
    const json = (await res.json()) as { id: number | string | null };
    expect(json.id).toBeNull();
  });

  it('always uses code -32600 for policy errors', async () => {
    upstream = await startFakeUpstream();
    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', upstream.url]]),
      policies: buildPolicySet({ srv: { default: { tools: { allow: ['fetch'] } } } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'denied' } }),
    });
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32600);
  });
});

describe('mcp-auth-proxy — upstream failures', () => {
  it('returns 502 "Bad Gateway" when the upstream is unreachable', async () => {
    // Pick a port we know nothing is listening on by closing it before use.
    const dummy = createServer();
    await new Promise<void>((resolve) => dummy.listen(0, '127.0.0.1', resolve));
    const deadPort = (dummy.address() as { port: number }).port;
    await new Promise<void>((resolve) => dummy.close(() => resolve()));

    const proxyUrl = await startProxy({
      upstreams: new Map([['srv', `http://127.0.0.1:${deadPort}`]]),
      policies: buildPolicySet({ srv: { default: { tools: { allow: ['fetch'] } } } }),
      assignments: new Map([['srv', makeAssignments('default')]]),
    });

    const res = await fetch(`${proxyUrl}/srv`, {
      method: 'POST',
      headers: { 'X-NanoClaw-Group': 'g1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch' } }),
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Bad Gateway/);
  });
});
