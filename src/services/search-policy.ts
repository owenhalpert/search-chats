import type { SessionSummary } from "./session-types";

export const SEARCH_POLICY = {
  retrieval: "hybrid" as const,
  reranker: "voyage/rerank-3-lite",
  candidates: 25,
  perSession: 3,
  threshold: 0.65,
  floor: 0.55,
  debounceMs: 150,
  instantCandidates: 50,
  highlights: true,
};

export interface RetrievalOptions {
  retrieval: "semantic" | "fts" | "hybrid";
  candidates: number;
  reranker?: string;
  perSession?: number;
  output?: number;
  highlights?: boolean;
}

const FUZZY_DISTANCE = [{ min_query_chars: 6, distance: 1 }, { min_query_chars: 9, distance: 2 }];

/** Ranks highlight fragments by exact words plus typo-tolerant matches of each word long enough to allow an edit. */
export function fragmentRanking(query: string): unknown[] {
  const bm25 = ["$fragment", "BM25", query];
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(word => word.length >= 6))];
  if (!words.length) return bm25;
  return ["Sum", [bm25, ...words.map(word => ["$fragment", "Fuzzy", word, { max_edit_distance: FUZZY_DISTANCE, case_sensitive: false }])]];
}

/** Hybrid retrieval with native reranking; thresholds were tuned against these exact requests. */
export function buildChatQuery(query: string, sessions: Pick<SessionSummary, "id">[], options: RetrievalOptions): Record<string, unknown> {
  const arm = (kind: "semantic" | "fts") => ({
    rank_by: ["text", kind === "semantic" ? "ANN" : "BM25", kind === "semantic" ? ["Embed", query] : query],
    limit: options.perSession
      ? { total: options.candidates, per: { attributes: ["agent", "session_id"], limit: options.perSession } }
      : options.candidates,
    filters: ["session_id", "In", [...new Set(sessions.map(s => s.id))]],
    // Native reranking requires the reranked attribute to be included.
    include_attributes: ["text", "session_id", "agent", "title", "role", "updated_at"],
    ...(options.highlights ? {
      compute_attributes: {
        highlight: ["Highlight", "text", {
          fragment_by: "sentence",
          fragment_limit: 1,
          rank_fragments_by: fragmentRanking(query),
          include_offsets: "utf-16",
        }],
      },
    } : {}),
  });
  const rerank = options.reranker ? [options.reranker, "text", query] : ["RRF"];
  return options.retrieval === "hybrid"
    ? { queries: [arm("semantic"), arm("fts")], rerank_by: rerank, limit: options.output ?? options.candidates }
    : { ...arm(options.retrieval), ...(options.reranker ? { rerank_by: rerank } : {}) };
}

/**
 * Keyword-only first paint for search-as-you-type. No embedding or reranker
 * call, so it costs one round trip plus a few milliseconds of search.
 */
export function buildInstantQuery(query: string): Record<string, unknown> {
  // The last word is usually still being typed.
  const prefix = { last_as_prefix: true };
  return {
    rank_by: ["text", "BM25", query, prefix],
    filters: ["text", "ContainsAllTokens", query, prefix],
    limit: { total: SEARCH_POLICY.instantCandidates, per: { attributes: ["agent", "session_id"], limit: 1 } },
    include_attributes: ["session_id", "agent"],
    compute_attributes: {
      highlight: ["Highlight", "text", {
        fragment_limit: 1,
        rank_fragments_by: ["$fragment", "BM25", query, prefix],
        include_offsets: "utf-16",
      }],
    },
    // A moment of staleness is fine here; strong reads add a storage round trip.
    consistency: { level: "eventual" },
  };
}

/** Scores are model-specific ranking signals, not probabilities. */
export function selectRelevant<T extends { score: number }>(ranked: T[]): T[] {
  const eligible = ranked.filter(hit => Number.isFinite(hit.score) && hit.score >= SEARCH_POLICY.floor);
  const confident = eligible.filter(hit => hit.score >= SEARCH_POLICY.threshold);
  // A single useful result can fall below the normal cutoff for a broad query.
  return confident.length ? confident : eligible.slice(0, 1);
}
