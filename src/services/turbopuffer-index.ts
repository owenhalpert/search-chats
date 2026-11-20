/**
 * Indexes chat transcripts into turbopuffer and searches them.
 *
 * The namespace schema declares `embed` on `text`, so turbopuffer embeds both
 * documents and queries. The same attribute carries a BM25 index for keyword
 * search. Indexing is incremental: only new or changed chats are uploaded.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CHUNK_OVERLAP_SENTENCES, CHUNK_TARGET_TOKENS, chunkText } from "./chunker.js";
import { matchesQuery } from "./format.js";
import { asArray, asRecord, asString } from "./jsonl.js";
import { cacheDirectory } from "./platform.js";
import { isLocalCommandCaveat } from "./prompt-text.js";
import { buildChatQuery, buildInstantQuery, SEARCH_POLICY, selectRelevant } from "./search-policy.js";
import { extractTranscript } from "./session-transcript.js";
import { isAgentKind, type AgentKind, type SessionSummary } from "./session-types.js";
import { queryNamespace, upsertRows, type TurbopufferRequestContext } from "./turbopuffer-client.js";

export const EMBEDDING_MODEL = "voyage/voyage-4-lite";
const NAMESPACE_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "search-chats",
  "namespace",
);
let namespaceCache: string | undefined;

/**
 * Coworkers often share one turbopuffer org, and some agents (Devin) use short
 * session ids, so each install gets its own namespace. It is created once and
 * kept in config, so clearing the cache never orphans an index.
 */
export function namespaceName(): string {
  if (namespaceCache !== undefined) return namespaceCache;
  if (process.env.SEARCH_CHATS_NAMESPACE) return (namespaceCache = process.env.SEARCH_CHATS_NAMESPACE);
  const user = os.userInfo().username.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
  const created = `search-chats-v1-${user}-${randomBytes(6).toString("hex")}`;
  mkdirSync(path.dirname(NAMESPACE_FILE), { recursive: true });
  try {
    writeFileSync(NAMESPACE_FILE, `${created}\n`, { flag: "wx" });
    return (namespaceCache = created);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (namespaceCache = readFileSync(NAMESPACE_FILE, "utf8").trim());
  }
}
const STATE_FILE = path.join(cacheDirectory, "turbopuffer-index.json");
const STATE_VERSION = 1;
/** Bump when schemaFor changes, so existing namespaces get a schema-only update. */
const SCHEMA_VERSION = 2;
/** Native embedding caps a write at 256 documents; throughput comes from concurrency. */
const EMBED_BATCH_ROWS = 256;
// Embedding throughput is capped by the org's rate limit, not by concurrency.
const WRITE_CONCURRENCY = 4;
/** Index far more of a long message than the reading view shows. */
const INDEX_MAX_MESSAGE_CHARS = 200_000;

export interface SearchHit {
  sessionId: string;
  agent: AgentKind;
  /** Best-matching fragment, as plain text. */
  snippet: string;
  /** Half-open utf-16 ranges of query matches within `snippet`. */
  matches: [number, number][];
  score: number;
  /** Present only after the native reranker and relevance gate. */
  rerankScore?: number;
}

interface IndexedSession {
  mtimeMs: number;
  chunkCount: number;
}

interface IndexState {
  version: number;
  namespace: string;
  schema?: number;
  sessions: Record<string, IndexedSession>;
}

const AGENT_CODES: Record<AgentKind, string> = { "claude-code": "cc", codex: "cx", cursor: "cu", devin: "dv", "devin-cloud": "dc" };

function sessionKey(session: { agent: AgentKind; id: string }): string {
  return `${AGENT_CODES[session.agent]}:${session.id}`;
}

/** Row ids must stay within turbopuffer's 64-byte limit. */
function rowId(agent: AgentKind, sessionId: string, chunkIndex: number): string {
  return `${AGENT_CODES[agent]}-${sessionId.slice(0, 48)}-${chunkIndex}`;
}

/** Null when no API key is set, which turns transcript search off. */
export function requestContext(): TurbopufferRequestContext | null {
  const apiKey = process.env.TURBOPUFFER_API_KEY?.trim();
  if (!apiKey) return null;
  const region = process.env.TURBOPUFFER_REGION?.trim();
  return { apiKey, baseUrl: region ? `https://${region}.turbopuffer.com` : "https://api.turbopuffer.com" };
}

async function loadState(): Promise<IndexState> {
  const empty: IndexState = { version: STATE_VERSION, namespace: namespaceName(), sessions: {} };
  try {
    const parsed = asRecord(JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as unknown);
    const sessions = asRecord(parsed?.sessions);
    if (parsed?.version !== STATE_VERSION || parsed.namespace !== empty.namespace || sessions === null) return empty;
    const restored: Record<string, IndexedSession> = {};
    for (const [key, value] of Object.entries(sessions)) {
      const entry = asRecord(value);
      if (typeof entry?.mtimeMs === "number" && typeof entry.chunkCount === "number") {
        restored[key] = { mtimeMs: entry.mtimeMs, chunkCount: entry.chunkCount };
      }
    }
    return { ...empty, schema: typeof parsed.schema === "number" ? parsed.schema : undefined, sessions: restored };
  } catch {
    // Missing or damaged state only costs a full re-upload; row ids are deterministic.
    return empty;
  }
}

let saveQueue: Promise<void> = Promise.resolve();
async function saveState(state: IndexState): Promise<void> {
  const snapshot = JSON.stringify(state);
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(cacheDirectory, { recursive: true });
    const tempPath = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, snapshot);
    await fs.rename(tempPath, STATE_FILE);
  });
  await saveQueue;
}

export async function hasIndex(): Promise<boolean> {
  return Object.keys((await loadState()).sessions).length > 0;
}

export async function staleSessions(sessions: SessionSummary[]): Promise<SessionSummary[]> {
  const state = await loadState();
  return sessions.filter(session => needsIndexing(session, state));
}

function needsIndexing(session: SessionSummary, state: IndexState): boolean {
  const entry = state.sessions[sessionKey(session)];
  if (entry === undefined) return true;
  return entry.mtimeMs !== Date.parse(session.updatedAt);
}

/** Build the chunk rows for one session, one message at a time. */
async function buildRows(
  session: SessionSummary,
): Promise<Record<string, unknown>[]> {
  const { items } = await extractTranscript(session, INDEX_MAX_MESSAGE_CHARS);

  const updatedAt = Math.floor(Date.parse(session.updatedAt) / 1000);
  const rows: Record<string, unknown>[] = [];

  for (const item of items) {
    if (item.kind !== "message") continue;

    for (const chunk of chunkText(
      item.text,
      CHUNK_TARGET_TOKENS,
      CHUNK_OVERLAP_SENTENCES,
    )) {
      rows.push({
        id: rowId(session.agent, session.id, rows.length),
        text: chunk,
        session_id: session.id,
        agent: session.agent,
        title: session.title,
        project: session.projectName,
        role: item.role,
        updated_at: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
  }

  return rows;
}

function schemaFor(model: string): Record<string, unknown> {
  // Only `text` needs declaring: it carries the native embedding, the BM25
  // index, and the fuzzy index for typo-tolerant highlights.
  return {
    text: {
      type: "string",
      full_text_search: true,
      fuzzy: true,
      embed: { model },
    },
  };
}

export interface IndexProgress {
  processed: number;
  total: number;
  chunksUploaded: number;
  /** Set while writes wait out a rate limit. */
  retryingUntil: number | null;
}

/**
 * Uploads new and changed chats, and removes chats that no longer exist.
 * Progress is saved as batches land, so an interrupted run resumes where it stopped.
 */
export async function indexSessions(
  sessions: SessionSummary[],
  onProgress: (progress: IndexProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<IndexProgress> {
  const base = requestContext();
  if (base === null) throw new Error("Set TURBOPUFFER_API_KEY to index chat transcripts.");
  const namespace = namespaceName();
  const state = await loadState();
  const pending = sessions.filter((session) => needsIndexing(session, state));
  const liveKeys = new Set(sessions.map(sessionKey));
  const removedKeys = Object.keys(state.sessions).filter((key) => !liveKeys.has(key));
  const progress: IndexProgress = { processed: 0, total: pending.length, chunksUploaded: 0, retryingUntil: null };
  onProgress(progress);
  const context: TurbopufferRequestContext = {
    ...base,
    onRetry: (waitMs) => {
      progress.retryingUntil = Math.max(progress.retryingUntil ?? 0, Date.now() + waitMs);
      onProgress(progress);
    },
  };

  const schema = schemaFor(EMBEDDING_MODEL);
  if (state.schema !== SCHEMA_VERSION) {
    // New namespaces get the schema with their first rows.
    if (Object.keys(state.sessions).length > 0) await upsertRows(context, namespace, { schema }, signal);
    state.schema = SCHEMA_VERSION;
  }

  // Rows from many sessions share one write request. Writes run concurrently,
  // but their state updates commit in order, so a session is only recorded
  // once every batch holding its rows has been written.
  let rows: Record<string, unknown>[] = [];
  let deletes: string[] = [];
  let updates: [string, IndexedSession | null][] = [];
  const inFlight = new Set<Promise<void>>();
  let commits: Promise<void> = Promise.resolve();
  let failed = false;

  const flush = async () => {
    if (failed) await commits; // rethrows the first write failure
    if (rows.length === 0 && deletes.length === 0 && updates.length === 0) {
      return;
    }
    signal?.throwIfAborted();
    while (inFlight.size >= WRITE_CONCURRENCY) await Promise.race(inFlight);

    const batch = { rows, deletes, updates };
    rows = [];
    deletes = [];
    updates = [];

    const upload =
      batch.rows.length === 0 && batch.deletes.length === 0
        ? Promise.resolve()
        : upsertRows(
            context,
            namespace,
            {
              ...(batch.rows.length > 0
                ? {
                    upsert_rows: batch.rows,
                    distance_metric: "cosine_distance",
                    schema,
                  }
                : {}),
              ...(batch.deletes.length > 0 ? { deletes: batch.deletes } : {}),
              // Backfills can outrun indexing; queries stay eventually consistent.
              disable_backpressure: true,
            },
            signal,
          );
    const settled = upload.then(
      () => undefined,
      () => {
        failed = true;
      },
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));

    commits = commits.then(async () => {
      await upload;
      for (const [key, entry] of batch.updates) {
        if (entry === null) delete state.sessions[key];
        else state.sessions[key] = entry;
      }
      progress.chunksUploaded += batch.rows.length;
      if ((progress.retryingUntil ?? 0) < Date.now()) progress.retryingUntil = null;
      onProgress(progress);
      await saveState(state);
    });
    commits.catch(() => undefined); // awaited later; avoid unhandled rejection
  };

  try {
    // Drop rows for sessions that disappeared from disk.
    for (const key of removedKeys) {
      const entry = state.sessions[key];
      if (entry === undefined) continue;
      const separator = key.indexOf(":");
      const agent = (Object.keys(AGENT_CODES) as AgentKind[]).find(kind => AGENT_CODES[kind] === key.slice(0, separator));
      if (agent !== undefined) {
        for (let index = 0; index < entry.chunkCount; index += 1) {
          deletes.push(rowId(agent, key.slice(separator + 1), index));
        }
      }
      updates.push([key, null]);
    }

    for (const session of pending) {
      signal?.throwIfAborted();

      let sessionRows: Record<string, unknown>[];
      try {
        sessionRows = await buildRows(session);
      } catch {
        // An unreadable chat is retried on the next run.
        progress.processed += 1;
        continue;
      }

      const key = sessionKey(session);
      const previous = state.sessions[key];

      // A re-indexed session can be shorter than before; remove the leftovers.
      if (previous !== undefined) {
        for (
          let index = sessionRows.length;
          index < previous.chunkCount;
          index += 1
        ) {
          deletes.push(rowId(session.agent, session.id, index));
        }
      }

      // Transcripts are append-only and row ids are sequential, so rows that
      // were already indexed are unchanged; only the new tail gets embedded.
      // ponytail: older rows keep a stale title if it changes; delete the index to refresh.
      const newRows =
        previous !== undefined && sessionRows.length >= previous.chunkCount
          ? sessionRows.slice(previous.chunkCount)
          : sessionRows;

      for (const row of newRows) {
        rows.push(row);
        if (rows.length >= EMBED_BATCH_ROWS) await flush();
      }

      updates.push([
        key,
        {
          mtimeMs: Date.parse(session.updatedAt),
          chunkCount: sessionRows.length,
        },
      ]);
      progress.processed += 1;
    }

    await flush();
    await commits;
  } finally {
    // Save completed sessions even when cancelled or a later upload fails.
    await saveState(state);
  }
  return progress;
}

type SearchContext = TurbopufferRequestContext & { namespace: string };
let searchContextCache: Promise<SearchContext | null> | undefined;

/** Resolved once per process so a keystroke never waits on disk. */
function searchContext(): Promise<SearchContext | null> {
  return (searchContextCache ??= (async () => {
    const context = requestContext();
    if (context === null || !(await hasIndex())) return null;
    return { ...context, namespace: namespaceName() };
  })());
}

/** Call after indexing so a first index becomes searchable without a restart. */
export function resetSearchContext(): void {
  searchContextCache = undefined;
}

/** Opens the connections a search needs before the first keystroke arrives. */
export async function warmSearch(): Promise<void> {
  const context = await searchContext();
  if (context === null) return;
  const ping = { rank_by: ["id", "asc"], limit: 1, include_attributes: [], consistency: { level: "eventual" } };
  await Promise.all([0, 1].map(() => queryNamespace(context, context.namespace, ping, AbortSignal.timeout(5000))));
}

/** Keyword passages for every keystroke, with no embedding or reranker call. */
export async function searchSessionsInstant(
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  const context = trimmed.length === 0 ? null : await searchContext();
  if (context === null) return [];
  const rows = await queryNamespace(context, context.namespace, buildInstantQuery(trimmed), signal);
  return keywordSearchHits(rows, trimmed, SEARCH_POLICY.instantCandidates);
}

/**
 * Diversified hybrid retrieval with native reranking and a measured relevance
 * gate. A reranker failure falls back to strict keyword passages.
 */
export async function searchSessions(
  query: string,
  sessions: SessionSummary[],
  limit = 20,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  signal?.throwIfAborted();
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const context = await searchContext();
  if (context === null) return [];
  const namespace = context.namespace;

  if (!sessions.length) return [];
  try {
    const rows = await queryNamespace(context, namespace, buildChatQuery(trimmed, sessions, SEARCH_POLICY), signal);
    return nativeSearchHits(rows).slice(0, limit);
  } catch {
    // Reranker or embedding trouble: fall back to strict keyword matches.
    signal?.throwIfAborted();
  }

  const fetchLimit = limit * 3;
  const bm25 = await rankedQuery(
      context,
      namespace,
      ["text", "BM25", trimmed],
      trimmed,
      fetchLimit,
      signal,
    );
  if (bm25.error !== null) throw bm25.error;
  return keywordSearchHits(bm25.rows, trimmed, limit);
}

export function nativeSearchHits(rows: Record<string, unknown>[]): SearchHit[] {
  const hits = new Map<string, SearchHit>();
  for (const row of rows) {
    const sessionId = asString(row.session_id);
    const highlighted = highlightSnippet(row);
    const snippet = highlighted.matches.length ? highlighted.snippet : asString(row.text);
    if (isLocalCommandCaveat(asString(row.text) ?? "") || isLocalCommandCaveat(snippet ?? "")) continue;
    const score = row.$dist;
    if (!sessionId || !snippet || typeof score !== "number" || !Number.isFinite(score)) continue;
    if (!isAgentKind(row.agent)) continue;
    const key = `${row.agent}:${sessionId}`;
    if (hits.has(key) && hits.get(key)!.score >= score) continue;
    hits.set(key, { sessionId, agent: row.agent, snippet, matches: highlighted.matches, score, rerankScore: score });
  }
  return selectRelevant([...hits.values()].sort((a, b) => b.score - a.score));
}

async function rankedQuery(
  context: TurbopufferRequestContext,
  namespace: string,
  rankBy: unknown[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ rows: Record<string, unknown>[]; error: unknown }> {
  try {
    const rows = await queryNamespace(context, namespace, {
      rank_by: rankBy,
      limit,
      include_attributes: ["session_id", "agent"],
      // Only highlighted passages containing the query words become matches.
      compute_attributes: {
        highlight: [
          "Highlight",
          "text",
          {
            fragment_limit: 1,
            rank_fragments_by: ["$fragment", "BM25", query],
            include_offsets: "utf-16",
          },
        ],
      },
    }, signal);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error };
  }
}

/** The row's best fragment and its merged, fragment-relative match ranges. */
function highlightSnippet(row: Record<string, unknown>): {
  snippet: string;
  matches: [number, number][];
} {
  const fragment = asRecord((asArray(row.highlight) ?? [])[0]);
  const text = fragment === null ? null : asString(fragment.text);
  if (fragment === null || text === null) return { snippet: "", matches: [] };

  const start = (asArray(fragment.fragment_range) ?? [0])[0];
  const offset = typeof start === "number" ? start : 0;

  const ranges: [number, number][] = [];
  for (const range of asArray(fragment.match_ranges) ?? []) {
    const [from, to] = (asArray(range) ?? []).map((value) =>
      typeof value === "number" ? value - offset : -1,
    );
    if (from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to)) continue;
    const start = Math.max(0, from), end = Math.min(to, text.length);
    if (end > start) ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const matches: [number, number][] = [];
  for (const range of ranges) {
    const last = matches.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else matches.push(range);
  }
  return { snippet: text, matches };
}

/** Reject unmatched top-k candidates before applying the session limit. */
export function keywordSearchHits(
  rows: Record<string, unknown>[],
  query: string,
  limit: number,
): SearchHit[] {
  if (!query.trim()) return [];
  const hits = new Map<string, SearchHit>();
  rows.forEach((row, index) => {
      const sessionId = asString(row.session_id);
      const agent = row.agent;
      if (sessionId === null || !isAgentKind(agent)) return;

      const key = `${agent}:${sessionId}`;
      const { snippet, matches } = highlightSnippet(row);
      if (isLocalCommandCaveat(snippet)) return;
      if (!matches.length || !matchesQuery(snippet, query) || hits.has(key)) return;
      hits.set(key, { sessionId, agent, snippet, matches, score: 1 / (index + 1) });
  });
  return [...hits.values()].slice(0, limit);
}
