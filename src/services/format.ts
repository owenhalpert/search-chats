import { homedir } from "node:os";
import type { AgentKind, SessionSummary } from "./session-types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";

  const elapsed = Date.now() - time;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatAbsoluteTime(iso: string | null): string {
  if (iso === null) return "Unknown";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "Unknown";
  return new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Display paths the way a terminal prompt would. */
export function shortenHomePath(value: string): string {
  const home = homedir();
  return value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

export function filterSessions(
  sessions: SessionSummary[],
  query: string,
  agent: "all" | AgentKind,
): SessionSummary[] {
  return sessions.filter((session) => {
    if (agent !== "all" && session.agent !== agent) return false;
    // Branch, path, and id are shared by many chats, so matching them swamps results.
    return matchesQuery(`${session.title} ${session.preview} ${session.projectName}`, query);
  });
}

/** Local metadata and indexed passages must contain every query word. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
}
