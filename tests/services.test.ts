import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildShellSnippet } from "../src/model";
import { readTranscript } from "../src/services/session-transcript";
import { filterSessions } from "../src/services/format";
import { queryNamespace, retryPolicy, transport, upsertRows } from "../src/services/turbopuffer-client";
import type { SessionSummary } from "../src/services/session-types";

test("resume snippets preserve spaces and shell metacharacters as literal arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-chats-test-"));
  const cwd = join(root, "project ' spaces $(false)");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  try {
    for (const agent of ["codex", "claude-code"] as const) {
      const id = "session'; echo unsafe; $(false)";
      const snippet = buildShellSnippet(agent, id, cwd);
      const output = execFileSync("/bin/zsh", ["-c", `codex() { printf '%s\\n' "$PWD" "$@"; }; claude() { printf '%s\\n' "$PWD" "$@"; }; ${snippet}`], { encoding: "utf8" });
      assert.deepEqual(output.trimEnd().split("\n"), [cwd, agent === "codex" ? "resume" : "--resume", id]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transcript readers tolerate malformed lines and extract both providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-chats-transcript-"));
  try {
    for (const agent of ["codex", "claude-code"] as const) {
      const file = join(root, `${agent}.jsonl`);
      const row = (text: string) => agent === "codex" ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } } : { type: "user", message: { role: "user", content: text } };
      const appCommand = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
      await writeFile(file, [
        'bad json',
        JSON.stringify(row('<local-command-caveat>Ignore local command output</local-command-caveat>')),
        JSON.stringify(row(appCommand)),
        JSON.stringify(row(`${appCommand}\n<pasted_content id="be55">Find the missing index</pasted_content>`)),
        '',
      ].join('\n'));
      const transcript = await readTranscript({ filePath: file, agent, id: agent });
      assert.equal(transcript.messageCount, 1);
      assert.ok(transcript.items.some(i => i.kind === "message" && i.text === "Find the missing index"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local search matches all tokens and respects agent filter", () => {
  const session = { agent: "codex", id: "abc", title: "Fix indexing", preview: "missing chunks", projectName: "puffer", cwd: "/tmp/puffer", gitBranch: "main" } as SessionSummary;
  assert.equal(filterSessions([session], "PUFFER chunks", "all").length, 1);
  assert.equal(filterSessions([session], "puffer absent", "all").length, 0);
  assert.equal(filterSessions([session], "", "claude-code").length, 0);
});

test("turbopuffer requests preserve namespace, authorization, query, and cancellation", async () => {
  const original = transport.send;
  const requests: {url: string; init?: {headers: Record<string,string>}}[] = [];
  transport.send = async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ rows: [{ session_id: "fixture" }] }), { status: 200 }); };
  try {
    const rows = await queryNamespace({ baseUrl: "https://example.test", apiKey: "fixture-key" }, "test/index", { rank_by: ["text", "BM25", "hello"] });
    assert.equal(rows[0].session_id, "fixture");
    assert.equal(requests[0].url, "https://example.test/v2/namespaces/test%2Findex/query");
    assert.equal((requests[0].init?.headers as Record<string,string>).Authorization, "Bearer fixture-key");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(upsertRows({ baseUrl: "https://example.test", apiKey: "fixture-key" }, "test", {}, controller.signal));
    assert.equal(requests.length, 1);
  } finally { transport.send = original; }
});

test("writes keep waiting out embedding rate limits; queries give up quickly", async () => {
  const original = { send: transport.send, baseMs: retryPolicy.baseMs };
  retryPolicy.baseMs = 1;
  let calls = 0;
  const waits: number[] = [];
  transport.send = async () => ++calls <= 8 ? new Response("{}", { status: 429 }) : new Response("{}", { status: 200 });
  const context = { baseUrl: "https://example.test", apiKey: "k", onRetry: (ms: number) => waits.push(ms) };
  try {
    await upsertRows(context, "ns", {});
    assert.equal(calls, 9);
    assert.equal(waits.length, 8);
    calls = 0;
    await assert.rejects(queryNamespace(context, "ns", {}), (error: { status?: number }) => error.status === 429);
    assert.equal(calls, 5);
  } finally { transport.send = original.send; retryPolicy.baseMs = original.baseMs; }
});
