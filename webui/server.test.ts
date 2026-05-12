import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createApp } from './server.js';
import { initDb, closeDb } from './db.js';
import { createV2Schema, seedAgentGroupWiring } from './test-helpers.js';

let tmpDir: string;
let groupsDir: string;
let server: http.Server;
let port: number;

function get(urlPath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    }).on('error', reject);
  });
}

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let respData = '';
        res.on('data', (chunk) => (respData += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(respData) });
          } catch {
            resolve({ status: res.statusCode!, body: respData });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-server-test-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(groupsDir, 'slack_main'), { recursive: true });
  fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# Global prompt', 'utf-8');
  fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '# Slack prompt', 'utf-8');

  const dbPath = path.join(tmpDir, 'v2.db');
  const db = new Database(dbPath);
  createV2Schema(db);
  seedAgentGroupWiring(db, {
    agentGroupId: 'ag-main',
    folder: 'whatsapp_main',
    name: 'Main Chat',
    channelType: 'whatsapp',
    platformId: 'main@s.whatsapp.net',
    engagePattern: '@Andy',
    isMain: 1,
  });
  seedAgentGroupWiring(db, {
    agentGroupId: 'ag-slack',
    folder: 'slack_main',
    name: 'Slack Main',
    channelType: 'slack',
    platformId: 'slack@main',
    engagePattern: '@Andy',
    isMain: 1,
    model: 'sonnet',
    maxToolRounds: 10,
    timeoutMs: 300000,
  });

  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       next_run, status, created_at, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'task-1', 'slack_main', 'slack@main', 'Daily standup', 'cron', '0 9 * * 1-5',
    '2024-06-03T09:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'group',
  );
  db.prepare(
    `INSERT INTO pipeline_task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('task-1', '2024-06-02T09:00:00.000Z', 4500, 'success', 'Done', null);
  db.close();
  initDb(dbPath);

  const app = createApp(groupsDir);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Health ---

describe('GET /api/v1/health', () => {
  it('returns ok status', async () => {
    const { status, body } = await get('/api/v1/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});

// --- Agent groups (Q7=β agent-group-primary) ---

describe('GET /api/v1/agent-groups', () => {
  it('returns all agent groups', async () => {
    const { status, body } = await get('/api/v1/agent-groups');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].folder).toBeTruthy();
    expect(body[0].wiringCount).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/v1/agent-groups/:folder', () => {
  it('returns detail with inline wirings', async () => {
    const { status, body } = await get('/api/v1/agent-groups/slack_main');
    expect(status).toBe(200);
    expect(body.folder).toBe('slack_main');
    expect(Array.isArray(body.wirings)).toBe(true);
    expect(body.wirings).toHaveLength(1);
    expect(body.wirings[0].isMain).toBe(true);
    expect(body.wirings[0].model).toBe('sonnet');
    expect(body.wirings[0].platformId).toBe('slack@main');
  });

  it('returns 404 for non-existent agent group', async () => {
    const { status } = await get('/api/v1/agent-groups/nonexistent');
    expect(status).toBe(404);
  });

  it('returns 400 for invalid folder name', async () => {
    const { status } = await get('/api/v1/agent-groups/..%2Fetc');
    expect(status).toBe(400);
  });
});

describe('PATCH /api/v1/agent-groups/:folder', () => {
  it('updates the main wiring model', async () => {
    const { status, body } = await request('PATCH', '/api/v1/agent-groups/slack_main', {
      model: 'haiku',
    });
    expect(status).toBe(200);
    const main = body.wirings.find((w: { isMain: boolean }) => w.isMain);
    expect(main.model).toBe('haiku');
  });
});

// --- Messaging groups (secondary nav; reverse wirings) ---

describe('GET /api/v1/messaging-groups', () => {
  it('returns all messaging groups', async () => {
    const { status, body } = await get('/api/v1/messaging-groups');
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0].platformId).toBeTruthy();
    expect(body[0].channelType).toBeTruthy();
  });
});

describe('GET /api/v1/messaging-groups/:id', () => {
  it('returns detail with wired agent groups (reverse lookup)', async () => {
    const { status, body } = await get('/api/v1/messaging-groups/mg-ag-slack');
    expect(status).toBe(200);
    expect(body.id).toBe('mg-ag-slack');
    expect(Array.isArray(body.wiredAgentGroups)).toBe(true);
    expect(body.wiredAgentGroups[0].folder).toBe('slack_main');
  });

  it('returns 404 for non-existent id', async () => {
    const { status } = await get('/api/v1/messaging-groups/nope');
    expect(status).toBe(404);
  });
});

// --- Prompts ---

describe('GET /api/v1/prompts/global', () => {
  it('returns global prompts', async () => {
    const { status, body } = await get('/api/v1/prompts/global');
    expect(status).toBe(200);
    expect(body.claude).toBe('# Global prompt');
    expect(body.ollama).toBeNull();
  });
});

describe('PUT /api/v1/prompts/global', () => {
  it('updates global prompt', async () => {
    const { status, body } = await request('PUT', '/api/v1/prompts/global', {
      claude: 'updated',
    });
    expect(status).toBe(200);
    expect(body.claude).toBe('updated');
    // Backup created
    expect(
      fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.md.bak'), 'utf-8'),
    ).toBe('# Global prompt');
  });
});

describe('GET /api/v1/agent-groups/:folder/prompts', () => {
  it('returns group prompts', async () => {
    const { status, body } = await get('/api/v1/agent-groups/slack_main/prompts');
    expect(status).toBe(200);
    expect(body.claude).toBe('# Slack prompt');
  });

  it('returns 404 for non-existent group', async () => {
    const { status } = await get('/api/v1/agent-groups/nonexistent/prompts');
    expect(status).toBe(404);
  });
});

describe('PUT /api/v1/agent-groups/:folder/prompts', () => {
  it('updates group prompts', async () => {
    const { status, body } = await request('PUT', '/api/v1/agent-groups/slack_main/prompts', {
      claude: 'new slack prompt',
    });
    expect(status).toBe(200);
    expect(body.claude).toBe('new slack prompt');
  });
});

// --- Tasks ---

describe('GET /api/v1/agent-groups/:folder/tasks', () => {
  it('returns tasks for a group', async () => {
    const { status, body } = await get('/api/v1/agent-groups/slack_main/tasks');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].scheduleType).toBe('cron');
  });
});

describe('GET /api/v1/tasks/:id', () => {
  it('returns a task', async () => {
    const { status, body } = await get('/api/v1/tasks/task-1');
    expect(status).toBe(200);
    expect(body.prompt).toBe('Daily standup');
  });

  it('returns 404 for non-existent task', async () => {
    const { status } = await get('/api/v1/tasks/nonexistent');
    expect(status).toBe(404);
  });
});

describe('PATCH /api/v1/tasks/:id', () => {
  it('updates task prompt', async () => {
    const { status, body } = await request('PATCH', '/api/v1/tasks/task-1', {
      prompt: 'Updated standup',
    });
    expect(status).toBe(200);
    expect(body.prompt).toBe('Updated standup');
  });
});

describe('GET /api/v1/tasks/:id/runs', () => {
  it('returns task runs', async () => {
    const { status, body } = await get('/api/v1/tasks/task-1/runs');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].durationMs).toBe(4500);
  });

  it('respects limit query param', async () => {
    const { status, body } = await get('/api/v1/tasks/task-1/runs?limit=0');
    expect(status).toBe(200);
    expect(body).toHaveLength(0);
  });
});

// --- Static files ---

describe('static file serving', () => {
  it('serves index.html at /', async () => {
    // Create the public dir with an index.html
    const publicDir = path.join(tmpDir, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html>test</html>', 'utf-8');

    // Recreate server with a publicDir override
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const app = createApp(groupsDir, publicDir);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
      });
    });

    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body).toContain('<html>test</html>');
  });
});

// --- 404 ---

describe('unknown routes', () => {
  it('returns 404 for unknown API route', async () => {
    const { status } = await get('/api/v1/unknown');
    expect(status).toBe(404);
  });
});
