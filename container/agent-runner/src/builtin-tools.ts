/**
 * Built-in tools for custom provider path (OpenAI function-calling format).
 * Mirrors SDK tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const WORKSPACE_GROUP = '/workspace/group';

export interface BuiltinToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
  };
}

export interface BuiltinToolExecutor {
  name: string;
  def: BuiltinToolDef;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const BASH_TIMEOUT_MS = 60_000;

function resolvePath(relativePath: string): string {
  const resolved = path.resolve(WORKSPACE_GROUP, relativePath);
  if (!resolved.startsWith(WORKSPACE_GROUP)) {
    throw new Error(`Path ${relativePath} resolves outside /workspace/group`);
  }
  return resolved;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    results.push(dir);
    return results;
  }
  const entries = fs.readdirSync(dir);
  for (const e of entries) {
    const full = path.join(dir, e);
    const st = fs.statSync(full);
    if (st.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function simpleGlob(pattern: string, baseDir: string): string[] {
  const allFiles = walkDir(baseDir);
  const normalized = pattern.trim() || '*';
  if (normalized === '**' || normalized.endsWith('/**')) {
    return allFiles;
  }
  const reStr = '^' + normalized.split('/').map((p) => p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.')).join('/') + '$';
  let re: RegExp;
  try {
    re = new RegExp(reStr);
  } catch {
    return allFiles;
  }
  return allFiles.filter((f) => {
    const rel = path.relative(baseDir, f).split(path.sep).join('/');
    return re.test(rel);
  });
}

export function getBuiltinTools(): BuiltinToolExecutor[] {
  return [
    {
      name: 'Bash',
      def: {
        type: 'function',
        function: {
          name: 'Bash',
          description: 'Run a bash command in the container. Use for running scripts, git, etc.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Bash command to run' } },
            required: ['command']
          }
        }
      },
      execute: async (args) => {
        const command = String(args.command ?? '');
        if (!command.trim()) return 'Error: empty command';
        try {
          const out = execSync(command, {
            cwd: WORKSPACE_GROUP,
            encoding: 'utf-8',
            timeout: BASH_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
          });
          return out || '(no output)';
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const stdout = (e.stdout ?? '').toString();
          const stderr = (e.stderr ?? '').toString();
          const msg = e.message ?? String(err);
          return `Error: ${msg}${stdout ? '\nstdout: ' + stdout : ''}${stderr ? '\nstderr: ' + stderr : ''}`;
        }
      }
    },
    {
      name: 'Read',
      def: {
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read contents of a file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Relative path from /workspace/group' } },
            required: ['path']
          }
        }
      },
      execute: async (args) => {
        const p = resolvePath(String(args.path ?? ''));
        try {
          return fs.readFileSync(p, 'utf-8');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'Write',
      def: {
        type: 'function',
        function: {
          name: 'Write',
          description: 'Write content to a file. Creates parent directories if needed.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path from /workspace/group' },
              content: { type: 'string', description: 'Content to write' }
            },
            required: ['path', 'content']
          }
        }
      },
      execute: async (args) => {
        const p = resolvePath(String(args.path ?? ''));
        const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, 'utf-8');
          return `Wrote ${args.path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'Edit',
      def: {
        type: 'function',
        function: {
          name: 'Edit',
          description: 'Edit a file: replace old_string with new_string (first occurrence), or apply a simple patch.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path from /workspace/group' },
              old_string: { type: 'string', description: 'Exact string to find' },
              new_string: { type: 'string', description: 'Replacement string' }
            },
            required: ['path', 'old_string', 'new_string']
          }
        }
      },
      execute: async (args) => {
        const p = resolvePath(String(args.path ?? ''));
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        try {
          const content = fs.readFileSync(p, 'utf-8');
          if (!content.includes(oldStr)) return `Error: old_string not found in file`;
          const newContent = content.replace(oldStr, newStr);
          fs.writeFileSync(p, newContent, 'utf-8');
          return `Edited ${args.path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'Glob',
      def: {
        type: 'function',
        function: {
          name: 'Glob',
          description: 'List files matching a glob pattern (e.g. **/*.ts, src/**). Paths relative to /workspace/group.',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Glob pattern' } },
            required: ['pattern']
          }
        }
      },
      execute: async (args) => {
        const pattern = String(args.pattern ?? '*');
        try {
          const files = simpleGlob(pattern, WORKSPACE_GROUP);
          const relative = files.map((f) => path.relative(WORKSPACE_GROUP, f));
          return relative.length ? relative.join('\n') : '(no matches)';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'Grep',
      def: {
        type: 'function',
        function: {
          name: 'Grep',
          description: 'Search for a pattern in files under /workspace/group. Returns matching lines.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Search pattern (regex or literal)' },
              path: { type: 'string', description: 'Optional path or glob to limit search' }
            }
          }
        }
      },
      execute: async (args) => {
        const pattern = String(args.pattern ?? '');
        const pathArg = args.path != null ? String(args.path) : '**';
        try {
          const re = new RegExp(pattern, 'g');
          const files = pathArg === '**' ? simpleGlob('**/*', WORKSPACE_GROUP) : simpleGlob(pathArg, WORKSPACE_GROUP);
          const lines: string[] = [];
          for (const f of files) {
            if (!fs.statSync(f).isFile()) continue;
            try {
              const content = fs.readFileSync(f, 'utf-8');
              const rel = path.relative(WORKSPACE_GROUP, f);
              content.split('\n').forEach((line, i) => {
                if (re.test(line)) lines.push(`${rel}:${i + 1}: ${line.trim()}`);
              });
            } catch {
              // skip binary or unreadable
            }
          }
          return lines.length ? lines.join('\n') : '(no matches)';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'WebSearch',
      def: {
        type: 'function',
        function: {
          name: 'WebSearch',
          description: 'Search the web. (Simplified: returns a note that web search is not implemented in custom provider mode.)',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
            required: ['query']
          }
        }
      },
      execute: async () => {
        return 'WebSearch is not implemented in custom provider mode. Use WebFetch with a specific URL if you have one.';
      }
    },
    {
      name: 'WebFetch',
      def: {
        type: 'function',
        function: {
          name: 'WebFetch',
          description: 'Fetch content from a URL. Returns response text or error.',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'URL to fetch' } },
            required: ['url']
          }
        }
      },
      execute: async (args) => {
        const url = String(args.url ?? '');
        if (!url.startsWith('http://') && !url.startsWith('https://')) return 'Error: URL must start with http:// or https://';
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'NanoClaw/1.0' } });
          const text = await res.text();
          if (!res.ok) return `Error: ${res.status} ${res.statusText}\n${text.slice(0, 500)}`;
          return text.slice(0, 100_000);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  ];
}
