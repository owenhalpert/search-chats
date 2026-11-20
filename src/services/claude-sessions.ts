/**
 * Claude Code stores one JSONL transcript per session at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
 *
 * Useful records:
 *  - `{"type":"user", message, cwd, gitBranch, version, timestamp}` — prompts
 *  - `{"type":"ai-title", aiTitle}` — generated title, rewritten as the chat grows
 *  - `{"type":"last-prompt", lastPrompt}` — most recent prompt excerpt
 */

import * as os from "node:os";
import * as path from "node:path";

import {
  asArray,
  asRecord,
  asString,
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

export const CLAUDE_PROJECTS_DIR = process.env.SEARCH_CHATS_CLAUDE_DIR || path.join(
  os.homedir(),
  ".claude",
  "projects",
);

interface ClaudeAccumulator {
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  startedAt: string | null;
}

export interface ClaudeSummaryInput {
  filePath: string;
  sizeBytes: number;
  updatedAt: string;
  lines: EdgeLines;
}

export function summarizeClaudeSession(
  input: ClaudeSummaryInput,
): SessionSummary | null {
  const accumulator: ClaudeAccumulator = {
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    startedAt: null,
  };

  scanLines(input.lines.headLines, accumulator, true);
  // Scanning the tail last lets the newest generated title win.
  scanLines(input.lines.tailLines, accumulator, false);

  const promptText = accumulator.firstPrompt ?? accumulator.lastPrompt;
  const title =
    accumulator.title ?? (promptText === null ? null : toTitle(promptText));
  // A transcript with no title and no prompt has nothing worth resuming.
  if (title === null) return null;

  const cwd = accumulator.cwd ?? decodeProjectDirectory(input.filePath);

  return {
    id: path.basename(input.filePath, ".jsonl"),
    agent: "claude-code",
    title,
    preview: promptText === null ? "" : toPreview(promptText),
    cwd,
    projectName: path.basename(cwd) || cwd,
    gitBranch: accumulator.gitBranch,
    origin: "CLI",
    cliVersion: accumulator.cliVersion,
    startedAt: accumulator.startedAt,
    updatedAt: input.updatedAt,
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    archived: false,
  };
}

function scanLines(
  lines: string[],
  accumulator: ClaudeAccumulator,
  isHead: boolean,
): void {
  for (const line of lines) {
    if (line.includes('"ai-title"')) {
      const value = asString(parseJsonLine(line)?.aiTitle);
      const cleaned = value === null ? "" : cleanPromptText(value);
      if (!isMetaPrompt(cleaned)) accumulator.title = toTitle(cleaned);
      continue;
    }

    if (line.includes('"last-prompt"')) {
      const value = asString(parseJsonLine(line)?.lastPrompt);
      const cleaned = value === null ? "" : cleanPromptText(value);
      if (!isMetaPrompt(cleaned)) accumulator.lastPrompt = cleaned;
      continue;
    }

    const wantsMetadata = accumulator.cwd === null && line.includes('"cwd"');
    const wantsPrompt =
      isHead &&
      accumulator.firstPrompt === null &&
      line.includes('"type":"user"');
    if (!wantsMetadata && !wantsPrompt) continue;

    const entry = parseJsonLine(line);
    if (entry === null) continue;

    if (accumulator.cwd === null) {
      const entryCwd = asString(entry.cwd);
      if (entryCwd !== null) {
        accumulator.cwd = entryCwd;
        accumulator.gitBranch = asString(entry.gitBranch);
        accumulator.cliVersion = asString(entry.version);
      }
    }

    if (isHead && accumulator.startedAt === null) {
      accumulator.startedAt = asString(entry.timestamp);
    }

    // Sidechain entries belong to sub-agents, not the user's own conversation.
    if (wantsPrompt && entry.type === "user" && entry.isSidechain !== true) {
      const text = cleanPromptText(extractClaudeMessageText(entry.message));
      if (text.length > 0 && !isMetaPrompt(text))
        accumulator.firstPrompt = text;
    }
  }
}

export function extractClaudeMessageText(message: unknown): string {
  const record = asRecord(message);
  if (record === null) return "";

  const content = record.content;
  if (typeof content === "string") return content;

  const blocks = asArray(content);
  if (blocks === null) return "";

  const parts: string[] = [];
  for (const block of blocks) {
    const item = asRecord(block);
    if (item === null || item.type !== "text") continue;
    const text = asString(item.text);
    if (text !== null) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * Fallback only: Claude encodes the project path by replacing `/` with `-`,
 * which is lossy for directories that contain dashes.
 */
function decodeProjectDirectory(filePath: string): string {
  const encoded = path.basename(path.dirname(filePath));
  if (!encoded.startsWith("-")) return encoded;
  return encoded.replace(/-/g, "/");
}
