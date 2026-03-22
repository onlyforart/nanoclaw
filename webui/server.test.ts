import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createApp } from './server.js';
import { initDb, closeDb } from './db.js';

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

  const dbPath = path.join(tmpDir, 'messages.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
      container_config TEXT, requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0, model TEXT DEFAULT NULL,
      temperature REAL DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL, timeout_ms INTEGER DEFAULT NULL
    );
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      model TEXT DEFAULT NULL, temperature REAL DEFAULT NULL, timezone TEXT DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL, timeout_ms INTEGER DEFAULT NULL
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      result TEXT, error TEXT
    );
  `);
  db.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, NULL, 1, 1, NULL, NULL, NULL, NULL)`).run(
    'main@s.whatsapp.net', 'Main Chat', 'whatsapp_main', '@Andy', '2024-01-01T00:00:00.000Z',
  );
  db.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL, ?, ?)`).run(
    'slack@main', 'Slack Main', 'slack_main', '@Andy', '2024-01-02T00:00:00.000Z', 'sonnet', 10, 300000,
  );
  db.prepare(`INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
    'task-1', 'slack_main', 'slack@main', 'Daily standup', 'cron', '0 9 * * 1-5',
    '2024-06-03T09:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'group',
  );
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-02T09:00:00.000Z', 4500, 'success', 'Done', null,
  );
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

// --- Groups ---

describe('GET /api/v1/groups', () => {
  it('returns all groups', async () => {
    const { status, body } = await get('/api/v1/groups');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
  });
});

describe('GET /api/v1/groups/:folder', () => {
  it('returns a single group', async () => {
    const { status, body } = await get('/api/v1/groups/slack_main');
    expect(status).toBe(200);
    expect(body.folder).toBe('slack_main');
    expect(body.model).toBe('sonnet');
  });

  it('returns 404 for non-existent group', async () => {
    const { status } = await get('/api/v1/groups/nonexistent');
    expect(status).toBe(404);
  });

  it('returns 400 for invalid folder name', async () => {
    const { status } = await get('/api/v1/groups/..%2Fetc');
    expect(status).toBe(400);
  });
});

describe('PATCH /api/v1/groups/:folder', () => {
  it('updates group model', async () => {
    const { status, body } = await request('PATCH', '/api/v1/groups/slack_main', {
      model: 'haiku',
    });
    expect(status).toBe(200);
    expect(body.model).toBe('haiku');
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

describe('GET /api/v1/groups/:folder/prompts', () => {
  it('returns group prompts', async () => {
    const { status, body } = await get('/api/v1/groups/slack_main/prompts');
    expect(status).toBe(200);
    expect(body.claude).toBe('# Slack prompt');
  });

  it('returns 404 for non-existent group', async () => {
    const { status } = await get('/api/v1/groups/nonexistent/prompts');
    expect(status).toBe(404);
  });
});

describe('PUT /api/v1/groups/:folder/prompts', () => {
  it('updates group prompts', async () => {
    const { status, body } = await request('PUT', '/api/v1/groups/slack_main/prompts', {
      claude: 'new slack prompt',
    });
    expect(status).toBe(200);
    expect(body.claude).toBe('new slack prompt');
  });
});

// --- Tasks ---

describe('GET /api/v1/groups/:folder/tasks', () => {
  it('returns tasks for a group', async () => {
    const { status, body } = await get('/api/v1/groups/slack_main/tasks');
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
