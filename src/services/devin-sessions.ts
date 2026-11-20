/**
 * Devin CLI keeps every local session in one SQLite database at
 * `~/.local/share/devin/cli/sessions.db`.
 *
 *  - `sessions`: id, working_directory, title, last_activity_at (unix seconds), hidden
 *  - `prompt_history`: what the user typed, per session
 *  - `message_nodes`: chat messages as JSON; compaction and forks copy earlier
 *    messages under new node ids but keep their `message_id`. User messages that
 *    Devin injected lack `metadata.is_user_input`.
 */

import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { asArray, asRecord, asString } from "./jsonl.js";
import { openReadOnly } from "./platform.js";
import { cleanPromptText, isMetaPrompt, toPreview, toTitle } from "./prompt-text.js";
import type { ChatMessage, SessionSummary } from "./session-types.js";

export const DEVIN_DB = path.join(
  process.env.SEARCH_CHATS_DEVIN_DIR ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "devin", "cli"),
  "sessions.db",
);

interface SessionRow {
  id: string;
  cwd: string;
  title: string | null;
  prompt: string | null;
  created_at: number;
  last_activity_at: number;
}

export async function listDevinSessions(): Promise<SessionSummary[]> {
  if (!(await access(DEVIN_DB).then(() => true, () => false))) return [];
  const db = openReadOnly(DEVIN_DB);
  try {
    const rows = db.prepare(`
      SELECT s.id, s.working_directory AS cwd, s.title, s.created_at, s.last_activity_at,
        (SELECT content FROM prompt_history p WHERE p.session_id = s.id AND p.is_shell = 0
          ORDER BY p.timestamp LIMIT 1) AS prompt
      FROM sessions s WHERE s.hidden = 0`).all() as unknown as SessionRow[];
    return rows.flatMap((row): SessionSummary[] => {
      const prompt = row.prompt === null ? "" : cleanPromptText(row.prompt);
      const title = row.title?.trim() || (isMetaPrompt(prompt) ? "" : prompt);
      if (!title) return [];
      return [{
        id: row.id,
        agent: "devin",
        title: toTitle(title),
        preview: toPreview(prompt),
        cwd: row.cwd,
        projectName: path.basename(row.cwd) || row.cwd,
        gitBranch: null,
        origin: "CLI",
        cliVersion: null,
        startedAt: new Date(row.created_at * 1000).toISOString(),
        updatedAt: new Date(row.last_activity_at * 1000).toISOString(),
        filePath: DEVIN_DB,
        sizeBytes: 0,
        archived: false,
      }];
    });
  } finally {
    db.close();
  }
}

export function readDevinMessages(dbPath: string, sessionId: string): ChatMessage[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .prepare("SELECT chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY node_id")
      .all(sessionId) as { chat_message: string; created_at: number }[];
    const seen = new Set<string>();
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      let message: Record<string, unknown> | null;
      try { message = asRecord(JSON.parse(row.chat_message)); } catch { continue; }
      const role = message?.role;
      if (message === null || (role !== "user" && role !== "assistant")) continue;
      const id = asString(message.message_id);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const metadata = asRecord(message.metadata);
      if (role === "user" && metadata?.is_user_input !== true) continue;
      // Slash commands are expanded into the skill body; the blocks keep what the user typed.
      const typed = (asArray(asRecord(metadata?.extensions)?.["chisel/acp-content-blocks"]) ?? [])
        .flatMap(block => asString(asRecord(block)?.text) ?? []).join("\n\n");
      const tools = (asArray(message.tool_calls) ?? []).flatMap(call => asString(asRecord(call)?.name) ?? []);
      messages.push({
        role,
        text: typed || (asString(message.content) ?? ""),
        tools,
        timestamp: new Date(row.created_at * 1000).toISOString(),
      });
    }
    return messages;
  } finally {
    db.close();
  }
}
