import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const cacheDirectory = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "search-chats",
);

/** Loaded on first use so Claude and Codex keep working on Node builds without node:sqlite. */
export function openReadOnly(file: string): DatabaseSync {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(file, { readOnly: true });
}
