/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain } = ctx;

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a message to the user or group. The message is delivered immediately while you\'re still running. You can call this multiple times to send multiple messages.',
        {
          text: z.string().describe('The message text to send')
        },
        async (args) => {
          const data = {
            type: 'message',
            chatJid,
            text: args.text,
            groupFolder,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [{
              type: 'text',
              text: 'Message sent.'
            }]
          };
        }
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
          prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
          schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
          schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
          context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
          ...(isMain ? { target_group_jid: z.string().optional().describe('JID of the group to schedule the task for. The group must be registered — look up JIDs in /workspace/project/data/registered_groups.json (the keys are JIDs). If the group is not registered, let the user know and ask if they want to activate it. Defaults to the current group.') } : {}),
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [{ type: 'text', text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [{ type: 'text', text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [{ type: 'text', text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
                isError: true
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            context_mode: args.context_mode || 'group',
            targetJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`
            }]
          };
        }
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        'List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group\'s tasks.',
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

            if (tasks.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const formatted = tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
            ).join('\n');

            return {
              content: [{
                type: 'text',
                text: `Scheduled tasks:\n${formatted}`
              }]
            };
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause')
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} pause requested.`
            }]
          };
        }
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume')
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} resume requested.`
            }]
          };
        }
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel')
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} cancellation requested.`
            }]
          };
        }
      ),

      tool(
        'register_group',
        `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the group'),
          folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")')
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [{ type: 'text', text: 'Only the main group can register new groups.' }],
              isError: true
            };
          }

          const data = {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`
            }]
          };
        }
      )
    ]
  });
}

/** OpenAI function-calling format for custom provider path */
export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, { type: string; description?: string; enum?: string[] }>; required?: string[] };
  };
}

export interface OpenAIToolExecutor {
  name: string;
  def: OpenAIToolDef;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function getIpcToolsForOpenAI(ctx: IpcMcpContext): OpenAIToolExecutor[] {
  const { chatJid, groupFolder, isMain } = ctx;

  return [
    {
      name: 'mcp__nanoclaw__send_message',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__send_message',
          description: 'Send a message to the current WhatsApp group. Use this to proactively share information or updates.',
          parameters: { type: 'object', properties: { text: { type: 'string', description: 'The message text to send' } }, required: ['text'] }
        }
      },
      execute: async (args) => {
        const data = { type: 'message', chatJid, text: args.text as string, groupFolder, timestamp: new Date().toISOString() };
        const filename = writeIpcFile(MESSAGES_DIR, data);
        return `Message queued for delivery (${filename})`;
      }
    },
    {
      name: 'mcp__nanoclaw__schedule_task',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__schedule_task',
          description: `Schedule a recurring or one-time task. CONTEXT MODE: "group" (with chat history) or "isolated" (fresh). SCHEDULE: cron (e.g. "0 9 * * *"), interval (ms), or once (local time no Z).`,
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'What the agent should do when the task runs.' },
              schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'cron | interval | once' },
              schedule_value: { type: 'string', description: 'cron expr, milliseconds, or ISO timestamp (no Z)' },
              context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'group or isolated' },
              target_group: { type: 'string', description: 'Target group folder (main only)' }
            },
            required: ['prompt', 'schedule_type', 'schedule_value']
          }
        }
      },
      execute: async (args) => {
        const schedule_type = (args.schedule_type as string) || 'cron';
        const schedule_value = (args.schedule_value as string) || '';
        if (schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(schedule_value);
          } catch {
            return `Invalid cron: "${schedule_value}". Use format like "0 9 * * *" or "*/5 * * * *".`;
          }
        } else if (schedule_type === 'interval') {
          const ms = parseInt(schedule_value, 10);
          if (isNaN(ms) || ms <= 0) return `Invalid interval: "${schedule_value}". Must be positive milliseconds.`;
        } else if (schedule_type === 'once') {
          const date = new Date(schedule_value);
          if (isNaN(date.getTime())) return `Invalid timestamp: "${schedule_value}". Use ISO 8601.`;
        }
        const targetGroup = isMain && args.target_group ? (args.target_group as string) : groupFolder;
        const data = {
          type: 'schedule_task',
          prompt: args.prompt as string,
          schedule_type,
          schedule_value,
          context_mode: (args.context_mode as string) || 'group',
          groupFolder: targetGroup,
          chatJid,
          createdBy: groupFolder,
          timestamp: new Date().toISOString()
        };
        const filename = writeIpcFile(TASKS_DIR, data);
        return `Task scheduled (${filename}): ${schedule_type} - ${schedule_value}`;
      }
    },
    {
      name: 'mcp__nanoclaw__list_tasks',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__list_tasks',
          description: "List all scheduled tasks. From main: all tasks. From other groups: that group's tasks only.",
          parameters: { type: 'object', properties: {} }
        }
      },
      execute: async () => {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
        if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';
        try {
          const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
          const tasks = isMain ? allTasks : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
          if (tasks.length === 0) return 'No scheduled tasks found.';
          return `Scheduled tasks:\n${tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`).join('\n')}`;
        } catch (err) {
          return `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },
    {
      name: 'mcp__nanoclaw__pause_task',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__pause_task',
          description: 'Pause a scheduled task. It will not run until resumed.',
          parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID to pause' } }, required: ['task_id'] }
        }
      },
      execute: async (args) => {
        writeIpcFile(TASKS_DIR, { type: 'pause_task', taskId: args.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
        return `Task ${args.task_id} pause requested.`;
      }
    },
    {
      name: 'mcp__nanoclaw__resume_task',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__resume_task',
          description: 'Resume a paused task.',
          parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID to resume' } }, required: ['task_id'] }
        }
      },
      execute: async (args) => {
        writeIpcFile(TASKS_DIR, { type: 'resume_task', taskId: args.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
        return `Task ${args.task_id} resume requested.`;
      }
    },
    {
      name: 'mcp__nanoclaw__cancel_task',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__cancel_task',
          description: 'Cancel and delete a scheduled task.',
          parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID to cancel' } }, required: ['task_id'] }
        }
      },
      execute: async (args) => {
        writeIpcFile(TASKS_DIR, { type: 'cancel_task', taskId: args.task_id, groupFolder, isMain, timestamp: new Date().toISOString() });
        return `Task ${args.task_id} cancellation requested.`;
      }
    },
    {
      name: 'mcp__nanoclaw__register_group',
      def: {
        type: 'function',
        function: {
          name: 'mcp__nanoclaw__register_group',
          description: 'Register a new WhatsApp group (main only). Use available_groups.json for JID. Folder: lowercase with hyphens.',
          parameters: {
            type: 'object',
            properties: {
              jid: { type: 'string', description: 'WhatsApp JID (e.g. 120363336345536173@g.us)' },
              name: { type: 'string', description: 'Display name' },
              folder: { type: 'string', description: 'Folder name (e.g. family-chat)' },
              trigger: { type: 'string', description: 'Trigger word (e.g. @Andy)' }
            },
            required: ['jid', 'name', 'folder', 'trigger']
          }
        }
      },
      execute: async (args) => {
        if (!isMain) return 'Only the main group can register new groups.';
        writeIpcFile(TASKS_DIR, {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          trigger: args.trigger,
          timestamp: new Date().toISOString()
        });
        return `Group "${args.name}" registered. It will start receiving messages immediately.`;
      }
    }
  ];
}
