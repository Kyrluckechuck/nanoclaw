/**
 * NanoClaw Agent Runner — Direct CLI invocation
 * Runs inside a container, spawns `claude` CLI directly (no Agent SDK).
 * TOS-compliant: uses the official Claude Code CLI as intended.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Write MCP config file for the CLI's --mcp-config flag.
 */
function writeMcpConfig(mcpServerPath: string, containerInput: ContainerInput): string {
  const configPath = '/tmp/mcp-config.json';
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Send a user message to the CLI via stream-json stdin.
 */
function sendUserMessage(proc: ChildProcess, text: string): void {
  if (!proc.stdin || proc.stdin.destroyed) return;
  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  });
  proc.stdin.write(msg + '\n');
}

/**
 * Run a single query by spawning the Claude CLI directly.
 * Streams JSONL output and pipes IPC follow-up messages via stdin.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpConfigPath: string,
  containerInput: ContainerInput,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {

  // Build CLI arguments
  const cliArgs: string[] = [
    '-p',                              // print mode (non-interactive)
    '--output-format', 'stream-json',  // JSONL streaming output
    '--input-format', 'stream-json',   // JSONL streaming input (for follow-ups)
    '--verbose',                       // required with stream-json
    '--dangerously-skip-permissions',  // full tool access (container is the sandbox)
    '--mcp-config', mcpConfigPath,
  ];

  // Session resumption
  if (sessionId) {
    cliArgs.push('--resume', sessionId);
  }

  // Load global CLAUDE.md for non-main groups
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    const globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    cliArgs.push('--append-system-prompt', globalClaudeMd);
  }

  // Additional directories
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        cliArgs.push('--add-dir', fullPath);
      }
    }
  }

  log(`Spawning claude CLI (session: ${sessionId || 'new'})`);

  const claude = spawn('claude', cliArgs, {
    cwd: '/workspace/group',
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Send initial prompt
  sendUserMessage(claude, prompt);

  // Poll IPC for follow-up messages during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stdin');
      closedDuringQuery = true;
      claude.stdin?.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      sendUserMessage(claude, text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  return new Promise((resolve, reject) => {
    // Parse JSONL from stdout
    let buffer = '';
    claude.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          messageCount++;
          const msgType = message.type === 'system'
            ? `system/${message.subtype}`
            : message.type;
          log(`[msg #${messageCount}] type=${msgType}`);

          // Capture session ID from init
          if (message.type === 'system' && message.subtype === 'init') {
            newSessionId = message.session_id;
            log(`Session initialized: ${newSessionId}`);
          }

          // Track last assistant UUID for session resumption
          if (message.type === 'assistant' && message.uuid) {
            lastAssistantUuid = message.uuid;
          }

          // Log task notifications
          if (message.type === 'system' && message.subtype === 'task_notification') {
            log(`Task notification: task=${message.task_id} status=${message.status} summary=${message.summary}`);
          }

          // Emit results via output markers
          if (message.type === 'result') {
            resultCount++;
            const textResult = message.result || null;
            log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
            writeOutput({
              status: 'success',
              result: textResult,
              newSessionId,
            });
          }
        } catch {
          // Skip non-JSON lines (npm notices, warnings, etc.)
        }
      }
    });

    // Log stderr for debugging
    claude.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line) log(`[stderr] ${line}`);
      }
    });

    claude.on('close', (code) => {
      ipcPolling = false;
      log(`CLI exited (code: ${code}, messages: ${messageCount}, results: ${resultCount})`);

      if (code !== 0 && resultCount === 0) {
        reject(new Error(`Claude Code process exited with code ${code}`));
        return;
      }

      resolve({ newSessionId, lastAssistantUuid, closedDuringQuery });
    });

    claude.on('error', (err) => {
      ipcPolling = false;
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const mcpConfigPath = writeMcpConfig(mcpServerPath, containerInput);

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpConfigPath, containerInput);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
