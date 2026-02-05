/**
 * CLI entry: run NanoClaw agent without WhatsApp.
 * Usage: npm run ask -- "your question"   or   echo "your question" | npm run ask
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runContainerAgent } from './container-runner.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import type { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '@CLI',
  added_at: new Date().toISOString(),
};

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
  } catch {
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
    } catch (err) {
      console.error('Apple Container failed to start. Run: container system start');
      throw err;
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

async function main(): Promise<void> {
  const prompt =
    process.argv[2]?.trim() ||
    (await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => (data += chunk));
      process.stdin.on('end', () => resolve(data.trim()));
    }));

  if (!prompt) {
    console.error('Usage: npm run ask -- "your question"');
    console.error('   or: echo "your question" | npm run ask');
    process.exit(1);
  }

  ensureContainerSystemRunning();
  ensureDirs();

  const output = await runContainerAgent(MAIN_GROUP, {
    prompt,
    groupFolder: MAIN_GROUP.folder,
    chatJid: 'cli@local',
    isMain: true,
  });

  if (output.status === 'success' && output.result != null) {
    console.log(output.result);
  } else {
    console.error(output.error ?? 'Unknown error');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
