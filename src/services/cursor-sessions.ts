/**
 * Cursor CLI (`cursor-agent`) keeps each chat in its own SQLite store at
 * `~/.cursor/chats/<md5 of cwd>/<chat id>/store.db`, next to a `meta.json` with
 * the chat's cwd and last update.
 *
 *  - `meta`, key "0": hex-encoded JSON with agentId, name, createdAt (ms), latestRootBlobId
 *  - `blobs`: content-addressed by sha256. Messages are JSON blobs; tree nodes are
 *    protobuf whose 32-byte fields reference child blob ids, in conversation order.
 *
 * Chats from the Cursor editor live elsewhere and cannot be resumed from the CLI.
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { asArray, asRecord, asString } from "./jsonl.js";
import { openReadOnly } from "./platform.js";
import { cleanPromptText, isMetaPrompt, toPreview, toTitle } from "./prompt-text.js";
import type { ChatMessage, SessionSummary } from "./session-types.js";

export const CURSOR_CHATS_DIR = path.join(
  process.env.SEARCH_CHATS_CURSOR_DIR || path.join(os.homedir(), ".cursor"),
  "chats",
);

const DEFAULT_NAMES = new Set(["", "New Agent", "New Chat"]);
const MAX_SCAN_DEPTH = 8;

export function summarizeCursorChat(filePath: string, updatedAt: string): SessionSummary | null {
  const { meta, messages, workspacePath } = readStore(filePath);
  let cwd: string | null = null;
  try {
    cwd = asString(asRecord(JSON.parse(readFileSync(path.join(path.dirname(filePath), "meta.json"), "utf8")))?.cwd);
  } catch {
    // Older stores have no meta.json; the first prompt names the workspace.
  }
  const id = asString(meta.agentId) ?? path.basename(path.dirname(filePath));
  const prompt = messages.find(message => message.role === "user")?.text ?? "";
  const name = asString(meta.name)?.trim() ?? "";
  const title = DEFAULT_NAMES.has(name) ? prompt : name;
  if (!title) return null;
  const resolvedCwd = cwd ?? workspacePath ?? os.homedir();
  const createdAt = meta.createdAt;
  return {
    id,
    agent: "cursor",
    title: toTitle(title),
    preview: toPreview(prompt),
    cwd: resolvedCwd,
    projectName: path.basename(resolvedCwd) || resolvedCwd,
    gitBranch: null,
    origin: "CLI",
    cliVersion: null,
    startedAt: typeof createdAt === "number" ? new Date(createdAt).toISOString() : null,
    updatedAt,
    filePath,
    sizeBytes: 0,
    archived: false,
  };
}

export function readCursorMessages(filePath: string): ChatMessage[] {
  return readStore(filePath).messages;
}

function readStore(filePath: string) {
  const db = openReadOnly(filePath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | undefined;
    const meta = row === undefined ? {} : parseJson(Buffer.from(row.value, "hex")) ?? {};
    const getBlob = db.prepare("SELECT data FROM blobs WHERE id = ?");
    const blob = (id: string) => (getBlob.get(id) as { data: Uint8Array } | undefined)?.data;

    const records: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const data = blob(id);
      if (data !== undefined) inspect(Buffer.from(data), 0);
    };
    const inspect = (data: Buffer, depth: number) => {
      const json = parseJson(data);
      if (json !== null) records.push(json);
      else if (depth < MAX_SCAN_DEPTH) scanProtobuf(data, (field) => {
        if (field.length === 32 && blob(field.toString("hex")) !== undefined) visit(field.toString("hex"));
        else inspect(field, depth + 1);
      });
    };
    const root = asString(meta.latestRootBlobId);
    if (root !== null) visit(root);

    // Blobs are content-addressed and visited once, so records need no dedupe.
    // Message `id`s are not unique: every assistant message is "1".
    let workspacePath: string | null = null;
    const messages: ChatMessage[] = [];
    for (const record of records) {
      const role = record.role;
      if (role !== "user" && role !== "assistant") continue;
      if (asRecord(asRecord(record.providerOptions)?.cursor)?.isSummary === true) continue;
      const { text, tools } = contentOf(record.content);
      if (role === "user") {
        workspacePath ??= /^Workspace Path: (.+)$/m.exec(text)?.[1]?.trim() ?? null;
        const prompt = userQuery(text);
        if (prompt !== null) messages.push({ role, text: prompt, tools: [], timestamp: null });
      } else {
        messages.push({ role, text, tools, timestamp: null });
      }
    }
    return { meta, messages, workspacePath };
  } finally {
    db.close();
  }
}

/** Cursor wraps what the user typed in <user_query>; other user messages are injected context. */
function userQuery(text: string): string | null {
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)?.[1];
  const cleaned = cleanPromptText(query ?? (text.trimStart().startsWith("<") ? "" : text));
  return isMetaPrompt(cleaned) ? null : cleaned;
}

function contentOf(content: unknown): { text: string; tools: string[] } {
  if (typeof content === "string") return { text: content, tools: [] };
  const parts: string[] = [], tools: string[] = [];
  for (const block of asArray(content) ?? []) {
    const item = asRecord(block);
    if (item?.type === "text") parts.push(asString(item.text) ?? "");
    else if (item?.type === "tool-call" || item?.type === "tool_use") {
      const name = asString(item.toolName) ?? asString(item.name);
      if (name !== null) tools.push(name);
    }
  }
  return { text: parts.join("\n\n"), tools };
}

function parseJson(data: Buffer): Record<string, unknown> | null {
  if (data[0] !== 0x7b) return null;
  try {
    return asRecord(JSON.parse(data.toString("utf8")));
  } catch {
    return null;
  }
}

/** Calls `onField` for each length-delimited field; stops quietly at anything that is not protobuf. */
export function scanProtobuf(data: Buffer, onField: (field: Buffer) => void): void {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; offset < data.length && shift < 64; shift += 7) {
      const byte = data[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return -1;
  };
  while (offset < data.length) {
    const key = varint();
    if (key < 0) return;
    const wire = key % 8;
    if (wire === 0) { if (varint() < 0) return; }
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (length < 0 || offset + length > data.length) return;
      onField(data.subarray(offset, offset + length));
      offset += length;
    } else return;
  }
}
