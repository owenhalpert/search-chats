import { filterSessions, matchesQuery } from "./services/format";
import { AGENT_KINDS, type AgentKind, type SessionSummary } from "./services/session-types";
import type { SearchHit } from "./services/turbopuffer-index";
import { SEARCH_POLICY } from "./services/search-policy";

export type AgentFilter = "all" | AgentKind;
export const AGENTS: Record<AgentKind, { icon: string; label: string; color: string; command: string; resume: (id: string) => string[] }> = {
  codex: { icon: "◈", label: "Codex", color: "\x1b[38;5;80m", command: "codex", resume: id => ["resume", id] },
  "claude-code": { icon: "✳", label: "Claude", color: "\x1b[38;5;215m", command: "claude", resume: id => ["--resume", id] },
  cursor: { icon: "⬡", label: "Cursor", color: "\x1b[38;5;111m", command: "cursor-agent", resume: id => ["--resume", id] },
  devin: { icon: "✦", label: "Devin", color: "\x1b[38;5;114m", command: "devin", resume: id => ["--resume", id] },
  "devin-cloud": { icon: "✧", label: "Devin Cloud", color: "\x1b[38;5;114m", command: "devin", resume: id => ["--cloud", "--resume", `devin-${id}`] },
};

/** Tab cycles through "all" plus every agent that has chats on this machine. */
export function filtersFor(sessions: SessionSummary[]): AgentFilter[] {
  return ["all", ...AGENT_KINDS.filter(kind => sessions.some(session => session.agent === kind))];
}

export interface ChatResult {
  session: SessionSummary;
  hit?: SearchHit;
  local: boolean;
}

export function sessionKey(session: Pick<SessionSummary, "agent" | "id">): string {
  return `${session.agent}:${session.id}`;
}

/** Search relevance determines membership; last activity always determines order. */
export function resultsFor(
  sessions: SessionSummary[], query: string, filter: AgentFilter, hits: SearchHit[],
): ChatResult[] {
  const localKeys = new Set(filterSessions(sessions, query, filter).map(sessionKey));
  const hitByKey = new Map<string, SearchHit>();
  if (query.trim()) {
    for (const hit of hits) {
      const reranked = typeof hit.rerankScore === "number" && Number.isFinite(hit.rerankScore) && hit.rerankScore >= SEARCH_POLICY.floor;
      if (!reranked && !matchesQuery(hit.snippet, query)) continue;
      const key = `${hit.agent}:${hit.sessionId}`;
      if (!hitByKey.has(key)) hitByKey.set(key, hit);
    }
  }
  const results = new Map<string, ChatResult>();
  for (const session of sessions) {
    if (filter !== "all" && session.agent !== filter) continue;
    const key = sessionKey(session);
    if (!localKeys.has(key) && !hitByKey.has(key)) continue;
    results.set(key, { session, local: localKeys.has(key), hit: hitByKey.get(key) });
  }
  const time = (value: string) => Date.parse(value) || 0;
  return [...results.values()].sort((a, b) =>
    time(b.session.updatedAt) - time(a.session.updatedAt) ||
    sessionKey(a.session).localeCompare(sessionKey(b.session)),
  );
}

export function resumeSpec(session: Pick<SessionSummary, "agent" | "id" | "cwd">): { command: string; args: string[]; cwd: string } {
  const agent = AGENTS[session.agent];
  return { command: agent.command, args: agent.resume(session.id), cwd: session.cwd };
}

/** The equivalent command for the clipboard; inline resume uses literal argv. */
export function buildShellSnippet(agent: AgentKind, sessionId: string, cwd: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const spec = resumeSpec({ agent, id: sessionId, cwd });
  return `cd ${quote(cwd)} && ${[spec.command, ...spec.args].map(quote).join(" ")}`;
}
