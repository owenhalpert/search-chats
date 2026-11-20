export const AGENT_KINDS = ["codex", "claude-code", "cursor", "devin"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(value: unknown): value is AgentKind {
  return AGENT_KINDS.includes(value as AgentKind);
}

export interface SessionSummary {
  /** Session id the agent's CLI accepts for resuming. */
  id: string;
  agent: AgentKind;
  title: string;
  preview: string;
  /** Working directory the session ran in. */
  cwd: string;
  projectName: string;
  gitBranch: string | null;
  /** Where the session was started from, e.g. "CLI" or "Desktop". */
  origin: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  updatedAt: string;
  filePath: string;
  sizeBytes: number;
  archived: boolean;
}

export type TranscriptItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      timestamp: string | null;
    }
  | { kind: "tools"; id: string; names: string[]; timestamp: string | null }
  | { kind: "gap"; id: string; omittedCount: number };

export interface TranscriptResult {
  items: TranscriptItem[];
  totalItems: number;
  messageCount: number;
  truncated: boolean;
}

/** One message from an agent that stores chats in SQLite rather than JSONL. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: string[];
  timestamp: string | null;
}
