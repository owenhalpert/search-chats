import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "search-chats-agents-"));
process.env.SEARCH_CHATS_DEVIN_DIR = join(root, "devin");
process.env.SEARCH_CHATS_CURSOR_DIR = join(root, "cursor");
process.env.SEARCH_CHATS_CLAUDE_DIR = join(root, "claude");
process.env.SEARCH_CHATS_CODEX_DIR = join(root, "codex");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_CONFIG_HOME = join(root, "config");
// Agent directories are resolved at import time, after the env above.
const load = async () => ({
  ...(await import("../src/services/session-index")),
  ...(await import("../src/services/session-transcript")),
  ...(await import("../src/model")),
});

test.after(() => rm(root, { recursive: true, force: true }));

test("devin sessions list visible chats and dedupe messages copied by compaction", async () => {
  await mkdir(process.env.SEARCH_CHATS_DEVIN_DIR!, { recursive: true });
  const db = new DatabaseSync(join(process.env.SEARCH_CHATS_DEVIN_DIR!, "sessions.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT, working_directory TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, hidden INTEGER);
    CREATE TABLE prompt_history (content TEXT, timestamp INTEGER, session_id TEXT, is_shell INTEGER);
    CREATE TABLE message_nodes (session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER);
    INSERT INTO sessions VALUES ('nettle-chicken', '/work/api', 1790000000, 1790000500, NULL, 0), ('hidden-one', '/', 1, 2, 'Sub-agent', 1);
    INSERT INTO prompt_history VALUES ('ls', 1, 'nettle-chicken', 1), ('Find the flaky retry test', 2, 'nettle-chicken', 0);
  `);
  const insert = db.prepare("INSERT INTO message_nodes VALUES ('nettle-chicken', ?, ?, 1790000000)");
  const message = (id: string, role: string, content: string, extra = {}) => JSON.stringify({ message_id: id, role, content, ...extra });
  insert.run(0, message("s", "system", "You are Devin"));
  const typed = { metadata: { is_user_input: true } };
  insert.run(1, message("u1", "user", "Find the flaky retry test", typed));
  insert.run(2, message("a1", "assistant", "Found it in retry.rs", { tool_calls: [{ name: "exec" }] }));
  insert.run(3, message("u1", "user", "Find the flaky retry test", typed));
  insert.run(4, message("k1", "user", "keepalive"));
  insert.run(5, message("u2", "user", "# Skill body", { metadata: { is_user_input: true, extensions: { "chisel/acp-content-blocks": [{ type: "text", text: "/triage now" }] } } }));
  db.close();

  const { listSessions, readTranscript, resumeSpec } = await load();
  const sessions = (await listSessions()).filter(s => s.agent === "devin");
  assert.deepEqual(sessions.map(s => [s.id, s.title, s.cwd]), [["nettle-chicken", "Find the flaky retry test", "/work/api"]]);
  assert.equal(sessions[0].updatedAt, new Date(1790000500 * 1000).toISOString());
  const transcript = await readTranscript(sessions[0]);
  assert.deepEqual(transcript.items.map(i => i.kind === "message" ? i.text : i.kind === "tools" ? i.names : i.kind),
    ["Find the flaky retry test", "Found it in retry.rs", ["exec"], "/triage now"]);
  assert.deepEqual(resumeSpec(sessions[0]), { command: "devin", args: ["--resume", "nettle-chicken"], cwd: "/work/api" });
});

test("cursor chats follow the blob tree in order and keep only what the user typed", async () => {
  const chatId = "5f1c2b6e-0000-4000-8000-000000000001";
  const dir = join(process.env.SEARCH_CHATS_CURSOR_DIR!, "chats", "workspacehash", chatId);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);");
  const put = (data: Buffer) => {
    const id = createHash("sha256").update(data).digest("hex");
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(id, data);
    return id;
  };
  const json = (value: unknown) => put(Buffer.from(JSON.stringify(value)));
  // Inserted out of order, so only the tree walk can recover the sequence.
  // Cursor gives every assistant message the id "1".
  const lookup = json({ role: "assistant", id: "1", content: [{ type: "tool-call", toolName: "Read" }] });
  const answer = json({ role: "assistant", id: "1", content: [{ type: "text", text: "The retry loop never resets its backoff." }] });
  const injected = json({ role: "user", content: [{ type: "text", text: "<system_instruction>Be brief</system_instruction>" }] });
  const prompt = json({ role: "user", content: [{ type: "text", text: "<user_info>\nOS: darwin\nWorkspace Path: /stale/path\n</user_info>\n<user_query>\nWhy does the retry loop spin?\n</user_query>" }] });
  const ref = (id: string) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(id, "hex")]);
  const rootId = put(Buffer.concat([Buffer.from([0x10, 0x96, 0x01]), ref(injected), ref(prompt), ref(lookup), ref(answer)]));
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: chatId, name: "New Agent", createdAt: 1790000000000, latestRootBlobId: rootId })).toString("hex"));
  db.close();
  await writeFile(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: "/work/web", updatedAtMs: 1790000100000 }));

  const { listSessions, readTranscript, resumeSpec } = await load();
  const [session] = (await listSessions()).filter(s => s.agent === "cursor");
  assert.equal(session.id, chatId);
  assert.equal(session.title, "Why does the retry loop spin?");
  assert.equal(session.cwd, "/work/web");
  const transcript = await readTranscript(session);
  assert.deepEqual(transcript.items.map(i => i.kind === "message" ? `${i.role}: ${i.text}` : i.kind === "tools" ? i.names.join() : i.kind),
    ["user: Why does the retry loop spin?", "Read", "assistant: The retry loop never resets its backoff."]);
  assert.deepEqual(resumeSpec(session), { command: "cursor-agent", args: ["--resume", chatId], cwd: "/work/web" });
});

test("each install gets its own namespace, created once and reused", async () => {
  const { namespaceName } = await import("../src/services/turbopuffer-index");
  const { readFileSync } = await import("node:fs");
  const name = namespaceName();
  assert.match(name, /^search-chats-v1-[a-z0-9-]+-[0-9a-f]{12}$/);
  assert.equal(readFileSync(join(root, "config", "search-chats", "namespace"), "utf8").trim(), name);
  assert.equal(namespaceName(), name);
});
