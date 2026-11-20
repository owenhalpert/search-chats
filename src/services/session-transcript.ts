/**
 * Builds a readable transcript from a session file: user and assistant text,
 * with consecutive tool activity collapsed into a single summary row.
 */

import { extractClaudeMessageText } from "./claude-sessions.js";
import { extractCodexContentText } from "./codex-sessions.js";
import { readCursorMessages } from "./cursor-sessions.js";
import { readDevinMessages } from "./devin-sessions.js";
import {
  asArray,
  asRecord,
  asString,
  parseJsonLine,
  readLines,
} from "./jsonl.js";
import { cleanPromptText, isMetaPrompt } from "./prompt-text.js";
import type {
  ChatMessage,
  SessionSummary,
  TranscriptItem,
  TranscriptResult,
} from "./session-types.js";

type SessionRef = Pick<SessionSummary, "agent" | "id" | "filePath">;

const MAX_ITEMS = 300;
const MAX_TEXT_LENGTH = 12_000;
const MAX_TOOL_NAMES = 24;

const CODEX_TOOL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);

/**
 * Parse a whole transcript with no item cap. Indexing needs every message, and
 * a higher per-message text cap than the reading view uses.
 */
export async function extractTranscript(
  session: SessionRef,
  maxTextLength: number = MAX_TEXT_LENGTH,
): Promise<{ items: TranscriptItem[]; messageCount: number }> {
  const builder = new TranscriptBuilder(maxTextLength);
  if (session.agent === "claude-code") {
    await buildClaudeItems(readLines(session.filePath), builder);
  } else if (session.agent === "codex") {
    await buildCodexItems(readLines(session.filePath), builder);
  } else if (session.agent === "cursor") {
    addMessages(readCursorMessages(session.filePath), builder);
  } else {
    addMessages(readDevinMessages(session.filePath, session.id), builder);
  }
  return builder.finish();
}

export async function readTranscript(session: SessionRef): Promise<TranscriptResult> {
  const built = await extractTranscript(session);

  const totalItems = built.items.length;
  if (totalItems <= MAX_ITEMS) {
    return {
      items: built.items,
      totalItems,
      messageCount: built.messageCount,
      truncated: false,
    };
  }

  // Keep the start (what the session was about) and the end (where it left off).
  const half = Math.floor(MAX_ITEMS / 2);
  const items: TranscriptItem[] = [
    ...built.items.slice(0, half),
    { kind: "gap", id: "gap", omittedCount: totalItems - MAX_ITEMS },
    ...built.items.slice(totalItems - half),
  ];

  return {
    items,
    totalItems,
    messageCount: built.messageCount,
    truncated: true,
  };
}

class TranscriptBuilder {
  private readonly items: TranscriptItem[] = [];
  private pendingTools: { names: string[]; timestamp: string | null } | null =
    null;
  private counter = 0;
  private messageCount = 0;

  constructor(private readonly maxTextLength: number = MAX_TEXT_LENGTH) {}

  addMessage(
    role: "user" | "assistant",
    text: string,
    timestamp: string | null,
  ): void {
    const cleaned = cleanPromptText(text);
    if (cleaned.length === 0) return;
    if (role === "user" && isMetaPrompt(cleaned)) return;

    this.flushTools();
    this.messageCount += 1;
    this.counter += 1;
    this.items.push({
      kind: "message",
      id: `m${this.counter}`,
      role,
      text:
        cleaned.length > this.maxTextLength
          ? `${cleaned.slice(0, this.maxTextLength)}…`
          : cleaned,
      timestamp,
    });
  }

  addTool(name: string, timestamp: string | null): void {
    if (this.pendingTools === null) {
      this.pendingTools = { names: [], timestamp };
    }
    if (this.pendingTools.names.length < MAX_TOOL_NAMES) {
      this.pendingTools.names.push(name);
    }
  }

  finish(): { items: TranscriptItem[]; messageCount: number } {
    this.flushTools();
    return { items: this.items, messageCount: this.messageCount };
  }

  private flushTools(): void {
    if (this.pendingTools === null) return;
    this.counter += 1;
    this.items.push({
      kind: "tools",
      id: `t${this.counter}`,
      names: this.pendingTools.names,
      timestamp: this.pendingTools.timestamp,
    });
    this.pendingTools = null;
  }
}

async function buildClaudeItems(
  lines: AsyncIterable<string>,
  builder: TranscriptBuilder,
): Promise<void> {
  for await (const line of lines) {
    const entry = parseJsonLine(line);
    if (entry === null) continue;

    const type = asString(entry.type);
    if (type !== "user" && type !== "assistant") continue;
    if (entry.isSidechain === true) continue;

    const timestamp = asString(entry.timestamp);
    const message = asRecord(entry.message);
    if (message === null) continue;

    const blocks = asArray(message.content);
    if (blocks === null) {
      builder.addMessage(type, extractClaudeMessageText(message), timestamp);
      continue;
    }

    // Walk blocks in order so text and tool calls keep their original sequence.
    for (const block of blocks) {
      const item = asRecord(block);
      if (item === null) continue;
      const blockType = asString(item.type);

      if (blockType === "text") {
        const text = asString(item.text);
        if (text !== null) builder.addMessage(type, text, timestamp);
      } else if (blockType === "tool_use") {
        const name = asString(item.name);
        if (name !== null) builder.addTool(name, timestamp);
      }
    }
  }
}

async function buildCodexItems(
  lines: AsyncIterable<string>,
  builder: TranscriptBuilder,
): Promise<void> {
  for await (const line of lines) {
    const entry = parseJsonLine(line);
    if (entry === null) continue;
    if (asString(entry.type) !== "response_item") continue;

    const payload = asRecord(entry.payload);
    if (payload === null) continue;

    const timestamp = asString(entry.timestamp);
    const payloadType = asString(payload.type);

    if (payloadType === "message") {
      const role = asString(payload.role);
      if (role !== "user" && role !== "assistant") continue;
      builder.addMessage(
        role,
        extractCodexContentText(payload.content),
        timestamp,
      );
    } else if (payloadType !== null && CODEX_TOOL_TYPES.has(payloadType)) {
      builder.addTool(asString(payload.name) ?? payloadType, timestamp);
    }
  }
}

function addMessages(messages: ChatMessage[], builder: TranscriptBuilder): void {
  for (const message of messages) {
    builder.addMessage(message.role, message.text, message.timestamp);
    for (const tool of message.tools) builder.addTool(tool, message.timestamp);
  }
}
