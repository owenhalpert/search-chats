/**
 * Codex stores rollout transcripts at
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<id>.jsonl`, with
 * retired ones in `~/.codex/archived_sessions/`.
 *
 * Useful records:
 *  - `{"type":"session_meta", payload:{session_id, cwd, timestamp, originator, thread_source}}`
 *  - `{"type":"turn_context", payload:{cwd}}`
 *  - `{"type":"response_item", payload:{type:"message", role, content}}`
 *  - `{"type":"event_msg", payload:{type:"user_message", message}}`
 *
 * `~/.codex/session_index.jsonl` maps session ids to generated thread names.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  asArray,
  asRecord,
  asString,
  isFileNotFound,
  parseJsonLine,
  type EdgeLines,
} from "./jsonl.js";
import {
  cleanPromptText,
  isMetaPrompt,
  toPreview,
  toTitle,
} from "./prompt-text.js";
import type { SessionSummary } from "./session-types.js";

export const CODEX_DIR = process.env.SEARCH_CHATS_CODEX_DIR || path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
export const CODEX_ARCHIVED_SESSIONS_DIR = path.join(
  CODEX_DIR,
  "archived_sessions",
);
export const CODEX_SESSION_INDEX_FILE = path.join(
  CODEX_DIR,
  "session_index.jsonl",
);

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ORIGIN_LABELS: Record<string, string> = {
  "codex-tui": "CLI",
  "Codex Desktop": "Desktop",
  codex_exec: "Exec",
  codex_sdk_ts: "SDK",
};

/** Generated thread names, keyed by session id. */
export async function readCodexThreadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const entry = parseJsonLine(line);
      if (entry === null) continue;
      const id = asString(entry.id);
      const name = asString(entry.thread_name);
      const cleaned = name === null ? "" : cleanPromptText(name);
      if (id !== null && !isMetaPrompt(cleaned)) names.set(id, cleaned);
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  return names;
}

export interface CodexSummaryInput {
  filePath: string;
  sizeBytes: number;
  updatedAt: string;
  archived: boolean;
  lines: EdgeLines;
  threadNames: Map<string, string>;
}

export function summarizeCodexSession(
  input: CodexSummaryInput,
): SessionSummary | null {
  const meta = findSessionMeta(input.lines.headLines);
  if (meta === null) return null;
  // Guardian reviews and spawned sub-agents are not chats the user resumes.
  if (isSubagentSession(meta)) return null;

  const id =
    asString(meta.session_id) ??
    asString(meta.id) ??
    UUID_PATTERN.exec(input.filePath)?.[0] ??
    null;
  if (id === null) return null;

  let cwd = asString(meta.cwd);
  let firstPrompt: string | null = null;

  for (const line of input.lines.headLines) {
    if (cwd === null && line.includes('"cwd"')) {
      const payload = asRecord(parseJsonLine(line)?.payload);
      const value = payload === null ? null : asString(payload.cwd);
      if (value !== null) cwd = value;
    }

    if (firstPrompt !== null) {
      if (cwd !== null) break;
      continue;
    }
    if (!line.includes('"role":"user"') && !line.includes('"user_message"'))
      continue;

    const text = cleanPromptText(extractCodexUserText(line));
    if (text.length > 0 && !isMetaPrompt(text)) firstPrompt = text;
  }

  const threadName = input.threadNames.get(id) ?? null;
  const title =
    threadName !== null
      ? toTitle(threadName)
      : firstPrompt === null
        ? null
        : toTitle(firstPrompt);
  if (title === null) return null;

  const resolvedCwd = cwd ?? os.homedir();
  const originator = asString(meta.originator);

  return {
    id,
    agent: "codex",
    title,
    preview: firstPrompt === null ? "" : toPreview(firstPrompt),
    cwd: resolvedCwd,
    projectName: path.basename(resolvedCwd) || resolvedCwd,
    gitBranch: null,
    origin:
      originator === null ? null : (ORIGIN_LABELS[originator] ?? originator),
    cliVersion: asString(meta.cli_version),
    startedAt: asString(meta.timestamp),
    updatedAt: input.updatedAt,
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    archived: input.archived,
  };
}

function findSessionMeta(headLines: string[]): Record<string, unknown> | null {
  for (const line of headLines.slice(0, 5)) {
    if (!line.includes('"session_meta"')) continue;
    const payload = asRecord(parseJsonLine(line)?.payload);
    if (payload !== null) return payload;
  }
  return null;
}

function isSubagentSession(meta: Record<string, unknown>): boolean {
  const threadSource = asString(meta.thread_source);
  if (threadSource !== null && threadSource !== "user") return true;
  // Sub-agent runs record `source` as an object such as `{ subagent: {...} }`.
  const source = meta.source;
  return typeof source === "object" && source !== null;
}

function extractCodexUserText(line: string): string {
  const payload = asRecord(parseJsonLine(line)?.payload);
  if (payload === null) return "";

  if (payload.type === "user_message") return asString(payload.message) ?? "";
  if (payload.type === "message" && payload.role === "user") {
    return extractCodexContentText(payload.content);
  }
  return "";
}

export function extractCodexContentText(content: unknown): string {
  if (typeof content === "string") return content;

  const blocks = asArray(content);
  if (blocks === null) return "";

  const parts: string[] = [];
  for (const block of blocks) {
    const item = asRecord(block);
    if (item === null) continue;
    const type = asString(item.type);
    if (type !== "input_text" && type !== "output_text" && type !== "text")
      continue;
    const text = asString(item.text);
    if (text !== null) parts.push(text);
  }
  return parts.join("\n\n");
}
