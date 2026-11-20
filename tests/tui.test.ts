import { test } from "node:test";
import assert from "node:assert/strict";
import { resultsFor, resumeSpec } from "../src/model";
import { clean, clip, dropLastGrapheme, pad, width, wrap } from "../src/terminal";
import { render, type ViewState } from "../src/view";
import { queryNamespace, transport } from "../src/services/turbopuffer-client";
import type { SessionSummary } from "../src/services/session-types";
import { keywordSearchHits, type SearchHit } from "../src/services/turbopuffer-index";

const session = (id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, agent: "codex", title: "Fix indexing", preview: "missing chunks", cwd: "/tmp/puffer",
  projectName: "puffer", gitBranch: null, origin: "CLI", cliVersion: null,
  startedAt: null, updatedAt, filePath: `/tmp/${id}.jsonl`, sizeBytes: 1, archived: false, ...extra,
});
const hit = (s: SessionSummary, snippet = "indexing a match"): SearchHit => ({ sessionId: s.id, agent: s.agent, snippet, matches: [], score: 1 });

test("local and transcript matches are merged by recency, regardless of relevance or provider", () => {
  const old = session("old", "2026-01-01", { agent: "claude-code" });
  const recent = session("recent", "2026-10-15", { title: "Unrelated title", preview: "" });
  const middle = session("middle", "2026-08-01");
  const sessions = [old, recent, middle];
  const results = resultsFor(sessions, "indexing", "all", [hit(old), hit(recent), hit(middle), hit(old)]);
  assert.deepEqual(results.map(r => r.session.id), ["recent", "middle", "old"]);
  assert.equal(results[0].local, false);
  assert.equal(results[2].local, true);
  assert.equal(results[2].hit?.snippet, "indexing a match");
  assert.deepEqual(resultsFor(sessions, "indexing", "claude-code", [hit(recent)]).map(r => r.session.id), ["old"]);
  assert.deepEqual(resultsFor(sessions, "", "all", []).map(r => r.session.id), ["recent", "middle", "old"]);
});

test("identical IDs across providers remain separate; missing indexed sessions are ignored", () => {
  const codex = session("shared", "2026-01-02");
  const claude = session("shared", "2026-01-01", { agent: "claude-code" });
  const results = resultsFor([codex, claude], "absent", "all", [hit(codex, "absent"), hit(claude, "absent"), hit(session("deleted", "2026-01-03"), "absent")]);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(r => r.session.agent), ["codex", "claude-code"]);
});

test("a keyword query excludes semantic neighbors without a literal match, regardless of their scores", () => {
  const local = session("local", "2026-10-15", { title: "Deploy checklist" });
  const related = session("related", "2026-10-14", { title: "Release pipeline setup" });
  const irrelevant = session("irrelevant", "2026-10-16", { title: "Namespace indexing" });
  const hits = [hit(irrelevant, ""), { ...hit(irrelevant, "Ship the release"), score: 100 }, hit(related, "Configure the DEPLOY API")];
  assert.deepEqual(resultsFor([irrelevant, related, local], "deploy", "all", hits).map(r => r.session.id), ["local", "related"]);
  assert.deepEqual(resultsFor([related], "deploy rollback", "all", [hit(related, "Deploy API")]), []);
});

test("indexed keyword candidates need matching passages; deduplicate and limit only afterward", () => {
  const row = (id: string, text: string, matched = true) => ({
    session_id: id, agent: "codex",
    highlight: [{ text, fragment_range: [100, 100 + text.length], match_ranges: matched ? [[100, 106]] : [] }],
  });
  const rows = [
    { session_id: "no-snippet", agent: "codex" },
    row("unrelated", "Index maintenance"),
    row("no-highlight", "Deploy integration", false),
    row("first", "DEPLOY integration"), row("first", "Deploy again"),
    row("second", "Deploy rollback"),
    row("third", "Deploy docs"),
  ];
  assert.deepEqual(keywordSearchHits(rows, "deploy", 2).map(h => h.sessionId), ["first", "second"]);
  assert.deepEqual(keywordSearchHits(rows, "deploy rollback", 10).map(h => h.sessionId), ["second"]);
  assert.deepEqual(keywordSearchHits(rows, "", 10), []);
});

test("resume passes working directory and session IDs as literal argv", () => {
  const s = session("foo'; $(false)", "2026-01-01", { cwd: "/tmp/project ' $(false)" });
  assert.deepEqual(resumeSpec(s), { command: "codex", args: ["resume", s.id], cwd: s.cwd });
  assert.deepEqual(resumeSpec({ ...s, agent: "claude-code" }), { command: "claude", args: ["--resume", s.id], cwd: s.cwd });
});

test("transcript content cannot issue terminal commands; unicode stays within column budgets", () => {
  const hostile = "\x1b]52;c;clipboard\x07hello\x1b[2J\x1b[31m!\u202eevil";
  assert.equal(clean(hostile), "hello!evil");
  for (const text of ["普通话", "a👨‍👩‍👧‍👦b", "e\u0301 summer", "◈ Codex ✳ Claude", hostile]) {
    for (let columns = 1; columns < 20; columns++) {
      assert.ok(width(clip(text, columns)) <= columns, `${text} / ${columns}`);
      assert.equal(width(pad(text, columns)), columns);
      assert.ok(wrap(text, Math.max(2, columns)).every(line => width(line) <= Math.max(2, columns)));
    }
  }
  assert.equal(dropLastGrapheme("hi👨‍👩‍👧‍👦"), "hi");
  assert.equal(dropLastGrapheme("e\u0301"), "");
});

function stateFor(sessions: SessionSummary[]): ViewState {
  return { query: "", filter: "all", filters: ["all"], results: resultsFor(sessions, "", "all", []), total: sessions.length,
    selected: 0, top: 0, loading: false, searching: false, localOnly: true, status: "", transcript: null,
    transcriptLoading: false, transcriptError: "", detailOpen: false, previewFocus: false, previewScroll: 0, help: false };
}

test("empty, loading, split, transcript, help, and small-terminal frames fit the terminal", () => {
  const s = session("new", "2026-10-15", { title: "你 👨‍👩‍👧‍👦 \x1b[2J Test".repeat(20) });
  const state = stateFor([s, session("old", "2026-01-01", { agent: "claude-code" })]);
  for (const [columns, rows] of [[120, 40], [100, 25], [80, 24], [40, 10], [20, 5]]) {
    for (const variant of [state, { ...state, detailOpen: true }, { ...state, help: true }, stateFor([]), { ...stateFor([]), loading: true }]) {
      const frame = render(variant, columns, rows);
      assert.ok(frame.split("\r\n").length <= rows);
      assert.ok(frame.split("\r\n").every(line => width(line) < columns), `${columns}x${rows}`);
    }
  }
  const frame = clean(render(state, 120, 25));
  assert.ok(frame.includes("◈"));
  assert.ok(frame.includes("✳"));
  assert.ok(!frame.includes("All agents"));
  assert.ok(!frame.includes("Newest first"));
});

test("aborting an obsolete transcript request prevents retries", async () => {
  const original = transport.send;
  const controller = new AbortController();
  let requests = 0;
  transport.send = async (_url, init) => {
    requests++;
    controller.abort();
    init.signal.throwIfAborted();
    return new Response("{}");
  };
  try {
    await assert.rejects(queryNamespace({ apiKey: "fixture", baseUrl: "https://example.test" }, "test", {}, controller.signal));
    assert.equal(requests, 1);
  } finally { transport.send = original; }
});
