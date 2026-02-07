/**
 * Local HTTP server + single page for NanoClaw (no WhatsApp).
 * GET / → index.html; POST /ask → run agent, return JSON.
 */

import fs from 'fs';
import path from 'path';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { execSync } from 'child_process';

import { runContainerAgent } from './container-runner.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '@Web',
  added_at: new Date().toISOString(),
};

const DEFAULT_PORT = 3846;
const PORT = parseInt(process.env.WEB_PORT ?? String(DEFAULT_PORT), 10);

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
  } catch {
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
    } catch (err) {
      logger.warn({ err }, 'Apple Container failed to start');
      throw new Error('Apple Container not running. Run: container system start');
    }
  }
}

function ensureDirs(): void {
  const groupDir = path.join(GROUPS_DIR, MAIN_GROUP.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'env'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'ipc', MAIN_GROUP.folder, 'messages'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(DATA_DIR, 'ipc', MAIN_GROUP.folder, 'tasks'), {
    recursive: true,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: object): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(html);
}

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    logger.warn({ err }, 'Failed to read request body');
    sendJson(res, 400, { error: 'Invalid request body' });
    return;
  }
  let payload: { prompt?: string };
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, { error: 'Missing or empty prompt' });
    return;
  }

  logger.info({ promptLength: prompt.length }, 'Web /ask request');
  try {
    ensureContainerSystemRunning();
    ensureDirs();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Web /ask preflight failed');
    sendJson(res, 503, { status: 'error', error: msg });
    return;
  }

  try {
    const output = await runContainerAgent(MAIN_GROUP, {
      prompt,
      groupFolder: MAIN_GROUP.folder,
      chatJid: 'web@local',
      isMain: true,
    });
    logger.info(
      { status: output.status, hasResult: output.result != null },
      'Web /ask completed',
    );
    if (output.status === 'success') {
      sendJson(res, 200, { status: 'success', result: output.result ?? '' });
    } else {
      sendJson(res, 200, {
        status: 'error',
        error: output.error ?? 'Unknown error',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Web /ask agent error');
    sendJson(res, 500, { status: 'error', error: msg });
  }
}

function serveIndex(res: ServerResponse, projectRoot: string): void {
  const file = path.join(projectRoot, 'public', 'index.html');
  try {
    const html = fs.readFileSync(file, 'utf-8');
    sendHtml(res, 200, html);
  } catch (err) {
    logger.warn({ err, file }, 'Could not read index.html');
    sendJson(res, 500, { error: 'Missing public/index.html' });
  }
}

export function startWebServer(projectRoot: string): void {
  const server = createServer(async (req, res) => {
    // CORS for local use
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    if (pathname === '/ask') {
      await handleAsk(req, res);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      serveIndex(res, projectRoot);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  });

  server.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'Web server listening');
    console.log(`NanoClaw web: http://127.0.0.1:${PORT}`);
  });

  server.on('error', (err) => {
    logger.error({ err, port: PORT }, 'Web server error');
    throw err;
  });
}

function main(): void {
  const projectRoot = process.cwd();
  startWebServer(projectRoot);
}

main();
