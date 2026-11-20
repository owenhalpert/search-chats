/**
 * Devin CLI keeps every local session in one SQLite database at
 * `~/.local/share/devin/cli/sessions.db`.
 *
 *  - `sessions`: id, working_directory, title, last_activity_at (unix seconds), hidden
 *  - `prompt_history`: what the user typed, per session
 *  - `message_nodes`: chat messages as JSON; compaction and forks copy earlier
 *    messages under new node ids but keep their `message_id`. User messages that
 *    Devin injected lack `metadata.is_user_input`.
 *
 * Cloud sessions live only in Devin's API, which accepts the CLI's own login.
 */

import { access, readFile } from "node:fs/promises";
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
const DEVIN_CREDENTIALS = path.join(path.dirname(path.dirname(DEVIN_DB)), "credentials.toml");
const CLOUD_ORIGINS: Record<string, string> = { slack: "Slack", webapp: "Web", desktop: "Desktop", cli: "CLI", api: "API" };

type DevinApi = (route: string) => Promise<Record<string, unknown>>;

async function devinApi(): Promise<DevinApi | null> {
  const toml = await readFile(DEVIN_CREDENTIALS, "utf8").catch(() => "");
  const field = (name: string) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];
  const token = field("windsurf_api_key");
  if (!token) return null;
  const base = field("devin_api_url") || "https://api.devin.ai";
  return async route => {
    const response = await fetch(`${base}/v3/${route}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Devin API returned ${response.status}`);
    return asRecord(await response.json()) ?? {};
  };
}

/** Follows Devin's cursor pagination for a list route. */
async function allPages(api: DevinApi, route: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let after = "";
  for (;;) {
    const page = await api(`${route}${route.includes("?") ? "&" : "?"}first=200${after && `&after=${encodeURIComponent(after)}`}`);
    items.push(...(asArray(page.items) ?? []).map(asRecord).filter(item => item !== null));
    after = asString(page.end_cursor) ?? "";
    if (page.has_next_page !== true || !after) return items;
  }
}

/** The signed-in user's cloud sessions; empty when not signed in or offline. */
export async function listDevinCloudSessions(): Promise<SessionSummary[]> {
  try {
    const api = await devinApi();
    if (api === null) return [];
    const self = await api("self");
    const org = asString(self.devin_sessions_org_id) ?? asString(self.org_id);
    const user = asString(self.user_id);
    if (!org || !user) return [];
    const route = `organizations/${org}/sessions`;
    return (await allPages(api, `${route}?user_ids=${encodeURIComponent(user)}`)).flatMap((item): SessionSummary[] => {
      const id = asString(item.session_id);
      if (!id) return [];
      const origin = CLOUD_ORIGINS[asString(item.origin) ?? ""] ?? "Cloud";
      const seconds = (value: unknown) => new Date((typeof value === "number" ? value : 0) * 1000).toISOString();
      return [{
        id,
        agent: "devin-cloud",
        title: toTitle(asString(item.title) || "Untitled Devin session"),
        preview: "",
        cwd: os.homedir(),
        projectName: origin,
        gitBranch: null,
        origin,
        cliVersion: null,
        startedAt: seconds(item.created_at),
        updatedAt: seconds(item.updated_at),
        // Not a file: the API route the transcript is read from.
        filePath: `${route}/${id}`,
        sizeBytes: 0,
        archived: item.is_archived === true,
      }];
    });
  } catch {
    return [];
  }
}

export async function readDevinCloudMessages(route: string): Promise<ChatMessage[]> {
  const api = await devinApi();
  if (api === null) throw new Error("sign in with devin auth login to read cloud sessions");
  return (await allPages(api, `${route}/messages`)).map(item => ({
    role: item.source === "user" ? "user" : "assistant",
    text: asString(item.message) ?? "",
    tools: [],
    timestamp: typeof item.created_at === "number" ? new Date(item.created_at * 1000).toISOString() : null,
  }));
}

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
