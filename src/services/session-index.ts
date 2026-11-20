/**
 * Discovers chats from every supported agent and summarizes them. File-backed
 * chats are cached by mtime so repeat scans only parse what changed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { cacheDirectory } from "./platform.js";

import {
  CLAUDE_PROJECTS_DIR,
  summarizeClaudeSession,
} from "./claude-sessions.js";
import { CURSOR_CHATS_DIR, summarizeCursorChat } from "./cursor-sessions.js";
import { listDevinSessions } from "./devin-sessions.js";
import {
  CODEX_ARCHIVED_SESSIONS_DIR,
  CODEX_SESSIONS_DIR,
  readCodexThreadNames,
  summarizeCodexSession,
} from "./codex-sessions.js";
import {
  asRecord,
  mapLimit,
  readEdgeLines,
  type EdgeLines,
} from "./jsonl.js";
import { toTitle } from "./prompt-text.js";
import type { AgentKind, SessionSummary } from "./session-types.js";

const HEAD_BYTES = 192 * 1024;
const TAIL_BYTES = 64 * 1024;
const SCAN_CONCURRENCY = 8;
const STAT_CONCURRENCY = 24;
// Bump whenever summary parsing changes, so cached entries are rebuilt.
const CACHE_VERSION = 5;

interface FileRef {
  filePath: string;
  agent: AgentKind;
  archived: boolean;
}

interface DiscoveredFile extends FileRef {
  sizeBytes: number;
  mtimeMs: number;
}

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  /** `null` means "parsed, but not a resumable user session". */
  summary: SessionSummary | null;
}

let cachedEntries: Map<string, CacheEntry> | null = null;
let saveQueue: Promise<void> = Promise.resolve();

export async function listSessions(): Promise<SessionSummary[]> {
  const cache = await loadCache();

  const refs: FileRef[] = [];
  await collectClaudeFiles(refs);
  await collectCodexFiles(CODEX_SESSIONS_DIR, false, 0, refs);
  await collectCodexFiles(CODEX_ARCHIVED_SESSIONS_DIR, true, 0, refs);
  await collectCursorFiles(refs);

  const stats = await mapLimit(
    refs,
    STAT_CONCURRENCY,
    async (ref): Promise<DiscoveredFile | null> => {
      try {
        const stat = await fs.stat(ref.filePath);
        // Cursor rewrites meta.json on every turn. The store's own mtimes move
        // whenever anything, including this reader, opens it.
        const meta = ref.agent === "cursor"
          ? await fs.stat(path.join(path.dirname(ref.filePath), "meta.json")).catch(() => null)
          : null;
        return { ...ref, sizeBytes: stat.size, mtimeMs: meta?.mtimeMs ?? stat.mtimeMs };
      } catch {
        return null;
      }
    },
  );
  const files = stats.filter(
    (file): file is DiscoveredFile => file !== null && file.sizeBytes > 0,
  );

  const threadNames = await readCodexThreadNames();
  const nextEntries = new Map<string, CacheEntry>();

  const summaries = await mapLimit(files, SCAN_CONCURRENCY, async (file) => {
    const cached = cache.get(file.filePath);
    if (
      cached !== undefined &&
      cached.mtimeMs === file.mtimeMs &&
      cached.sizeBytes === file.sizeBytes
    ) {
      // Codex titles live in a separate index that can change without the
      // transcript changing, so re-apply the current thread name.
      const summary = applyThreadName(cached.summary, threadNames);
      nextEntries.set(file.filePath, { ...cached, summary });
      return summary;
    }

    const summary = await buildSummary(file, threadNames);
    nextEntries.set(file.filePath, {
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
      summary,
    });
    return summary;
  });

  cachedEntries = nextEntries;
  void persistCache(nextEntries);

  // An unreadable Devin database should not hide every other agent's chats.
  const devin = await listDevinSessions().catch(() => []);

  return [...summaries, ...devin]
    .filter((summary): summary is SessionSummary => summary !== null)
    .filter((summary) => !/^set up scheduled task\b/i.test(summary.title.trim()))
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
}

async function buildSummary(
  file: DiscoveredFile,
  threadNames: Map<string, string>,
): Promise<SessionSummary | null> {
  try {
    const updatedAt = new Date(file.mtimeMs).toISOString();
    if (file.agent === "cursor") return summarizeCursorChat(file.filePath, updatedAt);

    const lines: EdgeLines = await readEdgeLines(
      file.filePath,
      file.sizeBytes,
      HEAD_BYTES,
      TAIL_BYTES,
    );

    if (file.agent === "claude-code") {
      return summarizeClaudeSession({
        filePath: file.filePath,
        sizeBytes: file.sizeBytes,
        updatedAt,
        lines,
      });
    }

    return summarizeCodexSession({
      filePath: file.filePath,
      sizeBytes: file.sizeBytes,
      updatedAt,
      archived: file.archived,
      lines,
      threadNames,
    });
  } catch {
    return null;
  }
}

function applyThreadName(
  summary: SessionSummary | null,
  threadNames: Map<string, string>,
): SessionSummary | null {
  if (summary === null || summary.agent !== "codex") return summary;
  const name = threadNames.get(summary.id);
  if (name === undefined) return summary;
  const title = toTitle(name);
  return title === summary.title ? summary : { ...summary, title };
}

async function collectClaudeFiles(out: FileRef[]): Promise<void> {
  for (const entry of await readDirSafe(CLAUDE_PROJECTS_DIR)) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry.name);
    for (const file of await readDirSafe(projectDir)) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      out.push({
        filePath: path.join(projectDir, file.name),
        agent: "claude-code",
        archived: false,
      });
    }
  }
}

async function collectCodexFiles(
  dir: string,
  archived: boolean,
  depth: number,
  out: FileRef[],
): Promise<void> {
  // Sessions nest as sessions/YYYY/MM/DD; archived sessions are flat.
  if (depth > 4) return;
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCodexFiles(full, archived, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({ filePath: full, agent: "codex", archived });
    }
  }
}

async function collectCursorFiles(out: FileRef[]): Promise<void> {
  for (const workspace of await readDirSafe(CURSOR_CHATS_DIR)) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(CURSOR_CHATS_DIR, workspace.name);
    for (const chat of await readDirSafe(workspaceDir)) {
      if (!chat.isDirectory()) continue;
      out.push({
        filePath: path.join(workspaceDir, chat.name, "store.db"),
        agent: "cursor",
        archived: false,
      });
    }
  }
}

async function readDirSafe(dir: string): Promise<import("node:fs").Dirent[]> {
  return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function getCachePath(): Promise<string> {
  const cacheDir = cacheDirectory;
  await fs.mkdir(cacheDir, { recursive: true });
  return path.join(cacheDir, "session-index.json");
}

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (cachedEntries !== null) return cachedEntries;

  const entries = new Map<string, CacheEntry>();
  try {
    const raw = await fs.readFile(await getCachePath(), "utf8");
    const parsed = asRecord(JSON.parse(raw) as unknown);
    const stored =
      parsed?.version === CACHE_VERSION ? asRecord(parsed.entries) : null;
    if (stored !== null) {
      for (const [filePath, value] of Object.entries(stored)) {
        const entry = asRecord(value);
        if (entry === null) continue;
        if (
          typeof entry.mtimeMs !== "number" ||
          typeof entry.sizeBytes !== "number"
        )
          continue;
        entries.set(filePath, {
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
          summary: (asRecord(entry.summary) as SessionSummary | null) ?? null,
        });
      }
    }
  } catch {
    // The cache is derived data; a missing or damaged file just means a cold scan.
  }

  cachedEntries = entries;
  return entries;
}

async function persistCache(entries: Map<string, CacheEntry>): Promise<void> {
  const snapshot = JSON.stringify({
    version: CACHE_VERSION,
    entries: Object.fromEntries(entries),
  });

  const save = saveQueue
    .catch(() => undefined)
    .then(async () => {
      const filePath = await getCachePath();
      const tempPath = `${filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tempPath, snapshot);
        await fs.rename(tempPath, filePath);
      } finally {
        await fs.rm(tempPath, { force: true });
      }
    })
    .catch(() => {});

  saveQueue = save;
  await save;
}
