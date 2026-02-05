/**
 * Custom provider path: OpenAI-compatible API (e.g. DashScope, OpenRouter) with tool loop and session.
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { getIpcToolsForOpenAI } from './ipc-mcp.js';
import { getBuiltinTools } from './builtin-tools.js';

const WORKSPACE_GROUP = '/workspace/group';
const SESSIONS_DIR = path.join(WORKSPACE_GROUP, '.sessions');

/** Default path for config file (mount data/env so this file is available) */
const DEFAULT_CONFIG_PATH = '/workspace/env-dir/custom-provider.json';

interface CustomProviderConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

function loadCustomProviderConfig(log: LogFn): { baseURL: string; apiKey: string; model: string } | null {
  const configPath = process.env.CUSTOM_PROVIDER_CONFIG || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CustomProviderConfig;
    const baseURL = (raw.baseURL ?? process.env.CUSTOM_PROVIDER_BASE_URL)?.replace(/\/$/, '');
    const apiKey = raw.apiKey ?? process.env.CUSTOM_PROVIDER_API_KEY;
    const model = raw.model ?? process.env.CUSTOM_PROVIDER_MODEL ?? 'anthropic/claude-3.5-sonnet';
    if (baseURL && apiKey) {
      log(`Using custom provider config from ${configPath}`);
      return { baseURL, apiKey, model };
    }
  } catch (err) {
    log(`Failed to load custom provider config: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type LogFn = (message: string) => void;

interface ToolExecutor {
  name: string;
  def: { type: 'function'; function: { name: string; description: string; parameters: object } };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function getOpenAITools(executors: ToolExecutor[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return executors.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.def.function.name,
      description: t.def.function.description,
      parameters: t.def.function.parameters
    }
  })) as OpenAI.Chat.Completions.ChatCompletionTool[];
}

function getExecutorMap(executors: ToolExecutor[]): Map<string, ToolExecutor> {
  const m = new Map<string, ToolExecutor>();
  for (const t of executors) m.set(t.def.function.name, t);
  return m;
}

function loadSession(sessionId: string, log: LogFn): OpenAI.Chat.Completions.ChatCompletionMessageParam[] | null {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Array.isArray(raw.messages)) return raw.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  } catch (err) {
    log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function saveSession(sessionId: string, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], log: LogFn): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify({ messages }, null, 0), 'utf-8');
  } catch (err) {
    log(`Failed to save session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function randomSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runCustomProvider(
  input: ContainerInput,
  writeOutput: (out: ContainerOutput) => void,
  log: LogFn
): Promise<void> {
  const fromFile = loadCustomProviderConfig(log);
  const baseURL = fromFile?.baseURL ?? process.env.CUSTOM_PROVIDER_BASE_URL?.replace(/\/$/, '');
  const apiKey = fromFile?.apiKey ?? process.env.CUSTOM_PROVIDER_API_KEY;
  const model = fromFile?.model ?? process.env.CUSTOM_PROVIDER_MODEL ?? 'anthropic/claude-3.5-sonnet';

  if (!baseURL || !apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Set CUSTOM_PROVIDER_BASE_URL and CUSTOM_PROVIDER_API_KEY in .env, or create data/env/custom-provider.json with baseURL and apiKey'
    });
    return;
  }

  const client = new OpenAI({ baseURL, apiKey });

  const ctx = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  };
  const ipcTools = getIpcToolsForOpenAI(ctx);
  const builtinTools = getBuiltinTools();
  const allExecutors: ToolExecutor[] = [...ipcTools, ...builtinTools];
  const tools = getOpenAITools(allExecutors);
  const executorMap = getExecutorMap(allExecutors);

  let sessionId = input.sessionId ?? randomSessionId();
  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    loadSession(sessionId, log) ?? [];

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  if (messages.length === 0) {
    messages = [{ role: 'user', content: prompt }];
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const maxRounds = 30;
  let round = 0;
  let result: string | null = null;

  try {
    while (round < maxRounds) {
      round += 1;
      log(`Custom provider round ${round}`);

      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined
      });

      const choice = completion.choices?.[0];
      if (!choice?.message) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: 'No message in completion response'
        });
        return;
      }

      const msg = choice.message;
      messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          const argsStr = tc.function?.arguments ?? '{}';
          const executor = name ? executorMap.get(name) : undefined;
          let content: string;
          if (executor) {
            try {
              const args = JSON.parse(argsStr) as Record<string, unknown>;
              content = await executor.execute(args);
            } catch (err) {
              content = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            content = `Unknown tool: ${name ?? 'null'}`;
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content
          });
        }
        continue;
      }

      const contentParts = msg.content;
      const text = typeof contentParts === 'string'
        ? contentParts
        : Array.isArray(contentParts)
          ? (contentParts as Array<{ type?: string; text?: string }>).map((c: { type?: string; text?: string }) => c?.text ?? '').join('')
          : '';
      result = text || null;
      break;
    }

    if (result === null && round >= maxRounds) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: 'Max tool rounds exceeded'
      });
      return;
    }

    saveSession(sessionId, messages, log);
    log('Custom provider completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId: sessionId
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Custom provider error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    throw err;
  }
}
