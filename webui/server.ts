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
import {
  handleGetAgentGroups,
  handleGetAgentGroup,
  handlePatchAgentGroup,
  handleGetAgentGroupTokenUsage,
} from './routes/agent-groups.js';
import { handleGetMessagingGroups, handleGetMessagingGroup } from './routes/messaging-groups.js';
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
import { handleGetEvents } from './routes/events.js';
import { handleGetIntakeLogs } from './routes/intake.js';
import {
  handleGetObservations,
  handleGetObservation,
  handlePatchLabel,
  handleExportEvalSet,
} from './routes/observations.js';
import { handleGetPipeline } from './routes/pipeline.js';
import { handleGetClusters, handleGetCluster } from './routes/clusters.js';

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

    // Agent groups (Q7=β agent-group-primary)
    {
      method: 'GET',
      compiled: compilePath('/api/v1/agent-groups'),
      handler: () => handleGetAgentGroups(),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/agent-groups/:folder'),
      handler: (params) => {
        const result = handleGetAgentGroup(params.folder);
        if (!result) throw new HttpError(isValidFolder(params.folder) ? 404 : 400, isValidFolder(params.folder) ? 'Agent group not found' : 'Invalid folder name');
        return result;
      },
    },
    {
      method: 'PATCH',
      compiled: compilePath('/api/v1/agent-groups/:folder'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handlePatchAgentGroup(params.folder, body);
        if (!result) throw new HttpError(404, 'Agent group not found');
        return result;
      },
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/agent-groups/:folder/token-usage'),
      handler: (params, _req, query) => {
        const days = query.days ? parseInt(query.days, 10) : 30;
        const result = handleGetAgentGroupTokenUsage(params.folder, days);
        if (!result) throw new HttpError(isValidFolder(params.folder) ? 404 : 400, isValidFolder(params.folder) ? 'Agent group not found' : 'Invalid folder name');
        return result;
      },
    },

    // Messaging groups (secondary navigation; reverse-wirings on detail)
    {
      method: 'GET',
      compiled: compilePath('/api/v1/messaging-groups'),
      handler: () => handleGetMessagingGroups(),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/messaging-groups/:id'),
      handler: (params) => {
        const result = handleGetMessagingGroup(params.id);
        if (!result) throw new HttpError(404, 'Messaging group not found');
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
      compiled: compilePath('/api/v1/agent-groups/:folder/prompts'),
      handler: (params) => {
        const result = handleGetGroupPrompts(groupsDir, params.folder);
        if (!result) throw new HttpError(404, 'Agent group not found');
        return result;
      },
    },
    {
      method: 'PUT',
      compiled: compilePath('/api/v1/agent-groups/:folder/prompts'),
      handler: async (params, req) => {
        const body = (await parseJsonBody(req)) as any;
        const result = handlePutGroupPrompts(groupsDir, params.folder, body);
        if (!result) throw new HttpError(404, 'Agent group not found');
        return result;
      },
    },

    // Tasks (scoped under agent-groups; /api/v1/tasks/:id paths unchanged)
    {
      method: 'GET',
      compiled: compilePath('/api/v1/agent-groups/:folder/tasks'),
      handler: (params) => handleGetGroupTasks(params.folder),
    },
    {
      method: 'POST',
      compiled: compilePath('/api/v1/agent-groups/:folder/tasks'),
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

    // Containers — deferred to EKS phase (K.1.f step 9, Q5; see
    // project_webui_postcutover Deferred-2). containers route handler
    // was retired from main; reintroduce alongside the EKS work.

    // Pipeline overview
    {
      method: 'GET',
      compiled: compilePath('/api/v1/pipeline'),
      handler: (_params, _req, query) => handleGetPipeline(query),
    },

    // Clusters
    {
      method: 'GET',
      compiled: compilePath('/api/v1/clusters'),
      handler: (_params, _req, query) => handleGetClusters(query),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/clusters/:id'),
      handler: (params) => {
        const id = parseInt(params.id, 10);
        if (!Number.isFinite(id)) throw new HttpError(400, 'Invalid cluster id');
        return handleGetCluster(id);
      },
    },

    // Events
    {
      method: 'GET',
      compiled: compilePath('/api/v1/events'),
      handler: (_params, _req, query) => handleGetEvents(query),
    },

    // Intake logs
    {
      method: 'GET',
      compiled: compilePath('/api/v1/intake-logs'),
      handler: (_params, _req, query) => handleGetIntakeLogs(query),
    },

    // Observations — export-eval-set must be mounted before /:id so the
    // 'export-eval-set' literal doesn't get matched as an id.
    {
      method: 'GET',
      compiled: compilePath('/api/v1/observations/export-eval-set'),
      handler: () => handleExportEvalSet(),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/observations'),
      handler: (_params, _req, query) => handleGetObservations(query),
    },
    {
      method: 'GET',
      compiled: compilePath('/api/v1/observations/:id'),
      handler: (params) => {
        const id = parseInt(params.id, 10);
        if (!Number.isFinite(id)) throw new HttpError(400, 'Invalid observation id');
        const result = handleGetObservation(id);
        if (!result) throw new HttpError(404, 'Observation not found');
        return result;
      },
    },
    {
      method: 'PATCH',
      compiled: compilePath('/api/v1/observations/:id/label'),
      handler: async (params, req) => {
        const id = parseInt(params.id, 10);
        if (!Number.isFinite(id)) throw new HttpError(400, 'Invalid observation id');
        const body = (await parseJsonBody(req)) as any;
        return handlePatchLabel(id, body);
      },
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
