import https from 'node:https';
import path from 'node:path';

import pino from 'pino';

import { readEnvFile } from './env.js';
import { initDb } from './db.js';
import { createApp } from './server.js';
import { loadOrGenerateTls } from './tls.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const env = readEnvFile([
  'WEBUI_PORT',
  'WEBUI_BIND',
  'WEBUI_TLS_CA',
  'WEBUI_TLS_CERT',
  'WEBUI_TLS_KEY',
  'ASSISTANT_NAME',
]);

const port = parseInt(env.WEBUI_PORT || '3100', 10);
const bind = env.WEBUI_BIND || '127.0.0.1';

const tlsDir = path.resolve(process.cwd(), 'data', 'tls');

try {
  const tls = loadOrGenerateTls(tlsDir, env.WEBUI_TLS_CA, env.WEBUI_TLS_CERT, env.WEBUI_TLS_KEY);
  const groupsDir = path.resolve(process.cwd(), 'groups');
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');

  initDb();

  const app = createApp(groupsDir, publicDir);

  const server = https.createServer(
    {
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      requestCert: true,
      rejectUnauthorized: true,
    },
    app.listeners('request')[0] as any,
  );

  server.listen(port, bind, () => {
    logger.info(`NanoClaw Web UI listening on https://${bind}:${port}`);
    if (env.ASSISTANT_NAME) {
      logger.info(`Assistant: ${env.ASSISTANT_NAME}`);
    }
  });
} catch (err) {
  logger.fatal({ err }, 'Failed to start web UI');
  process.exit(1);
}
