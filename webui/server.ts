import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import {
  compilePath,
  matchPath,
  parseQuery,
  parseJsonBody,
  HttpError,
  type CompiledRoute,
} from './router.js';
import { handleGetGroups, handleGetGroup, handlePatchGroup, handleGetGroupTokenUsage } from './routes/groups.js';
import {
  handleGetGlobalPrompts,
  handlePutGlobalPrompts,
  handleGetGroupPrompts,
  handlePutGroupPrompts,
} from './routes/prompts.js';
import {
  handleGetGroupTasks,
  handleGetTask,
  handleCreateTask,
  handlePatchTask,
  handleDeleteTask,
  handleGetTaskRuns,
} from './routes/tasks.js';
import { handleGetContainers } from './routes/containers.js';

const startTime = Date.now();

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface Route {
  method: string;
  compiled: CompiledRoute;
  handler: (params: Record<string, string>, req: http.IncomingMessage, query: Record<string, string>) => unknown | Promise<unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function createApp(groupsDir: string, publicDir?: string): http.Server {
  const resolvedPublicDir = publicDir ?? path.join(__dirname, 'public');

  const routes: Route[] = [
    // Health
    {
      method: 'GET',
      compiled: compilePath('/api/v1/health'),
      handler: () => ({
        status: 'ok',
        version: process.env.npm_package_version ?? 'dev',
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }),
    },

    // Groups
    {
      method: 'GET',
      compiled: compilePath('/api/v1/groups'),
      handler: () => handleGetGroups(),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/groups/:folder'),
      handler: (params) => {
        const result = handleGetGroup(params.folder);
        if (!result) throw new HttpError(isValidFolder(params.folder) ? 404 : 400, isValidFolder(params.folder) ? 'Group not found' : 'Invalid folder name');
        return result;
      },
    },
    {
      method: 'PATCH',
      compiled: compilePath('/api/v1/groups/:folder'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handlePatchGroup(params.folder, body);
        if (!result) throw new HttpError(404, 'Group not found');
        return result;
      },
    },

    // Token usage
    {
      method: 'GET',
      compiled: compilePath('/api/v1/groups/:folder/token-usage'),
      handler: (params, _req, query) => {
        const days = query.days ? parseInt(query.days, 10) : 30;
        const result = handleGetGroupTokenUsage(params.folder, days);
        if (!result) throw new HttpError(isValidFolder(params.folder) ? 404 : 400, isValidFolder(params.folder) ? 'Group not found' : 'Invalid folder name');
        return result;
      },
    },

    // Prompts
    {
      method: 'GET',
      compiled: compilePath('/api/v1/prompts/global'),
      handler: () => handleGetGlobalPrompts(groupsDir),
    },
    {
      method: 'PUT',
      compiled: compilePath('/api/v1/prompts/global'),
      handler: async (_params, req) => {
        const body = (await parseJsonBody(req)) as any;
        return handlePutGlobalPrompts(groupsDir, body);
      },
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/groups/:folder/prompts'),
      handler: (params) => {
        const result = handleGetGroupPrompts(groupsDir, params.folder);
        if (!result) throw new HttpError(404, 'Group not found');
        return result;
      },
    },
    {
      method: 'PUT',
      compiled: compilePath('/api/v1/groups/:folder/prompts'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handlePutGroupPrompts(groupsDir, params.folder, body);
        if (!result) throw new HttpError(404, 'Group not found');
        return result;
      },
    },

    // Tasks
    {
      method: 'GET',
      compiled: compilePath('/api/v1/groups/:folder/tasks'),
      handler: (params) => handleGetGroupTasks(params.folder),
    },
    {
      method: 'POST',
      compiled: compilePath('/api/v1/groups/:folder/tasks'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handleCreateTask(params.folder, body);
        if ('error' in result) throw new HttpError(400, result.error);
        return result.task;
      },
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/tasks/:id'),
      handler: (params) => {
        const result = handleGetTask(params.id);
        if (!result) throw new HttpError(404, 'Task not found');
        return result;
      },
    },
    {
      method: 'PATCH',
      compiled: compilePath('/api/v1/tasks/:id'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handlePatchTask(params.id, body);
        if ('error' in result) throw new HttpError(400, result.error);
        return result.task;
      },
    },
    {
      method: 'DELETE',
      compiled: compilePath('/api/v1/tasks/:id'),
      handler: (params) => {
        const result = handleDeleteTask(params.id);
        if ('error' in result) throw new HttpError(404, result.error);
        return result;
      },
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/tasks/:id/runs'),
      handler: (params, _req, query) => {
        const limit = query.limit ? parseInt(query.limit, 10) : 20;
        return handleGetTaskRuns(params.id, limit);
      },
    },

    // Containers
    {
      method: 'GET',
      compiled: compilePath('/api/v1/containers'),
      handler: () => handleGetContainers(),
    },
  ];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const urlPath = url.split('?')[0];
    const method = req.method ?? 'GET';

    // API routes
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.compiled, urlPath);
      if (params === null) continue;

      try {
        const query = parseQuery(url);
        const result = await route.handler(params, req, query);
        json(res, 200, result);
      } catch (err) {
        if (err instanceof HttpError) {
          json(res, err.statusCode, { error: err.message });
        } else {
          json(res, 500, { error: 'Internal server error' });
        }
      }
      return;
    }

    // Check for matching path with wrong method (405)
    for (const route of routes) {
      if (matchPath(route.compiled, urlPath) !== null) {
        json(res, 405, { error: 'Method not allowed' });
        return;
      }
    }

    // Static file serving
    if (method === 'GET') {
      const filePath = urlPath === '/' ? '/index.html' : urlPath;
      const resolved = path.resolve(resolvedPublicDir, '.' + filePath);

      // Path traversal check
      if (!resolved.startsWith(resolvedPublicDir)) {
        json(res, 403, { error: 'Forbidden' });
        return;
      }

      try {
        const content = fs.readFileSync(resolved);
        const ext = path.extname(resolved);
        const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length,
        });
        res.end(content);
        return;
      } catch {
        // Fall through to 404
      }
    }

    json(res, 404, { error: 'Not found' });
  });

  return server;
}

// Re-import inline to avoid circular dependency — just checks the pattern
function isValidFolder(folder: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder) && folder.toLowerCase() !== 'global';
}
