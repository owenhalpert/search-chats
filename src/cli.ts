process.title = "search-chats";
// Node runtime warnings (such as node:sqlite being experimental) must never draw over the TUI.
process.removeAllListeners("warning");
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { listSessions } from "./services/session-index";
import { readTranscript } from "./services/session-transcript";
import {
  hasIndex, indexSessions, namespaceName, requestContext, resetSearchContext, searchSessions, searchSessionsInstant,
  staleSessions, warmSearch, type SearchHit,
} from "./services/turbopuffer-index";
import { matchesQuery } from "./services/format";
import type { SessionSummary } from "./services/session-types";
import { AGENTS, buildShellSnippet, filtersFor, resultsFor, resumeSpec, sessionKey } from "./model";
import { AGENT_KINDS, type AgentKind } from "./services/session-types";
import { clean, dropLastGrapheme } from "./terminal";
import { detailLines, detailViewportHeight, HELP_LINES, layout, render, type ViewState } from "./view";
import { SEARCH_POLICY } from "./services/search-policy";

const AGENT_NAMES: Record<string, AgentKind> = { codex: "codex", claude: "claude-code", "claude-code": "claude-code", cursor: "cursor", devin: "devin" };

const HELP = `search-chats: search and resume your coding agent chats

Usage: search-chats [--local] [--agent NAME] [query…]
       search-chats --list [--json] [--local] [--agent NAME] [query…]
       search-chats --index

${AGENT_KINDS.map(kind => `${AGENTS[kind].icon} ${AGENTS[kind].label}`).join("    ")}    Newest first.

Enter resumes the chat in this terminal. Ctrl-T reads the transcript.
Tab filters agents. Ctrl-Y copies the resume command. F1 shows all keys.

--agent    all, codex, claude, cursor, or devin
--local    Search titles and projects only, without transcript search
--list     Print matching chats without opening the TUI
--json     Print --list results as JSON
--index    Upload new and changed transcripts to turbopuffer
--help     Show this help

Transcript search needs TURBOPUFFER_API_KEY (and optionally TURBOPUFFER_REGION).
`;

interface Options { query: string; agent: ViewState["filter"]; local: boolean; list: boolean; json: boolean; index: boolean; }
function optionsFor(argv: string[]): Options {
  const options: Options = { query: "", agent: "all", local: false, list: false, json: false, index: false };
  const query: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--") { query.push(...argv.slice(i + 1)); break; }
    if (value === "--local") options.local = true;
    else if (value === "--list") options.list = true;
    else if (value === "--json") { options.json = true; options.list = true; }
    else if (value === "--index") options.index = true;
    else if (value === "--agent") {
      const agent = argv[++i];
      if (agent !== "all" && !(agent in AGENT_NAMES)) throw new Error("--agent needs all, codex, claude, cursor, or devin");
      options.agent = agent === "all" ? "all" : AGENT_NAMES[agent];
    } else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else query.push(value);
  }
  options.query = query.join(" ");
  return options;
}

class SearchChats {
  private sessions: SessionSummary[] = [];
  private keywordHits: SearchHit[] = [];
  private rerankHits: SearchHit[] = [];
  private instantInFlight = 0;
  private instantQueued = false;
  private instantSequence = 0;
  private instantApplied = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private previewRevision = 0;
  private searchRevision = 0;
  private active = false;
  private resuming = false;
  private pasting = false;
  private pasteBuffer = "";
  private previewKey = "";
  private indexing = false;
  private state: ViewState;

  constructor(options: Options) {
    this.state = {
      query: options.query, filter: options.agent, filters: ["all"], results: [], total: 0,
      selected: 0, top: 0, loading: true, searching: false,
      localOnly: options.local, status: "", transcript: null,
      transcriptLoading: false, transcriptError: "", detailOpen: false,
      previewFocus: false, previewScroll: 0, help: false,
    };
  }

  async run() {
    this.enter();
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", this.onKey);
    process.stdout.on("resize", this.draw);
    process.on("SIGINT", () => { if (!this.resuming) this.quit(); });
    process.on("SIGTERM", this.quit);
    process.on("uncaughtException", this.onCrash);
    process.once("exit", this.leave);
    this.state.loading = false;
    if (!this.state.localOnly) void warmSearch().catch(() => {});
    await this.refresh();
  }

  private enter() {
    process.title = "search-chats";
    this.active = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Save the terminal title, then set ours.
    process.stdout.write("\x1b[22;0t\x1b]2;⌕ Search Chats\x1b\\\x1b[?1049h\x1b[?25l\x1b[?2004h");
    this.draw();
  }

  private leave = () => {
    if (!this.active) return;
    this.active = false;
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l\x1b[23;0t");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  private quit = () => { this.leave(); process.exit(0); };
  private onCrash = (error: Error) => { this.leave(); console.error(error.message); process.exit(1); };
  private draw = () => {
    if (!this.active) return;
    if (this.state.selected >= this.state.top + this.listPage()) this.state.top = this.state.selected - this.listPage() + 1;
    // Home + clear every line, without clearing the whole screen between frames.
    const output = render(this.state, process.stdout.columns || 100, process.stdout.rows || 30);
    process.stdout.write("\x1b[H" + output.split("\r\n").map(line => line + "\x1b[K").join("\r\n") + "\x1b[J");
  };

  private selection() { return this.state.results[this.state.selected]?.session; }
  private layout() { return layout(process.stdout.columns || 100, process.stdout.rows || 30); }
  private listPage() { return this.layout().body; }

  private recompute(preserve = false) {
    const key = preserve && this.selection() ? sessionKey(this.selection()!) : undefined;
    this.state.results = resultsFor(this.sessions, this.state.query, this.state.filter, [...this.rerankHits, ...this.keywordHits]);
    this.state.total = this.sessions.length;
    const found = key ? this.state.results.findIndex(result => sessionKey(result.session) === key) : -1;
    this.state.selected = found >= 0 ? found : 0;
    this.state.top = Math.max(0, this.state.selected - this.listPage() + 1);
    this.loadPreview();
    this.draw();
  }

  private async refresh() {
    if (this.state.loading) return;
    this.state.loading = true;
    this.state.status = "";
    this.draw();
    try {
      this.sessions = await listSessions();
      this.state.filters = filtersFor(this.sessions);
      this.previewKey = "";
      this.recompute(true);
      this.scheduleSearch();
      void this.updateIndex();
    } catch (error) { this.state.status = `Scan failed: ${String(error)}`; }
    finally { this.state.loading = false; this.draw(); }
  }

  /** Keeps an existing transcript index current. The first full upload is left to --index. */
  private async updateIndex() {
    if (this.indexing || this.state.localOnly || requestContext() === null) return;
    if (!(await hasIndex())) {
      this.state.status = "Run search-chats --index once to search inside transcripts";
      this.draw();
      return;
    }
    this.indexing = true;
    try {
      const { chunksUploaded } = await indexSessions(this.sessions);
      if (chunksUploaded === 0) return;
      resetSearchContext();
      if (this.remote()) this.scheduleSearch();
    } catch (error) {
      this.state.status = `Index update failed: ${String(error)}`;
      this.draw();
    } finally { this.indexing = false; }
  }

  private remote() { return this.state.query.trim().length >= 2 && !this.state.localOnly; }

  private scheduleSearch() {
    clearTimeout(this.searchTimer);
    const revision = ++this.searchRevision;
    const query = this.state.query;
    // Passages that still contain every word stay on screen while new results load.
    this.keywordHits = !this.remote() ? [] : [...this.keywordHits, ...this.rerankHits]
      .filter(hit => matchesQuery(hit.snippet, query)).map(hit => ({ ...hit, rerankScore: undefined }));
    this.rerankHits = [];
    this.state.status = "";
    this.state.searching = this.remote();
    this.recompute(true);
    if (!this.remote()) return;
    this.searchInstant();
    this.searchTimer = setTimeout(async () => {
      try {
        const hits = await searchSessions(query, this.sessions, 100, AbortSignal.timeout(8000));
        if (revision !== this.searchRevision) return;
        this.rerankHits = hits;
        this.recompute(true);
      } catch (error) {
        if (revision === this.searchRevision) this.state.status = `Transcript search unavailable; local matches shown. ${String(error)}`;
      } finally {
        if (revision === this.searchRevision) { this.state.searching = false; this.draw(); }
      }
    }, SEARCH_POLICY.debounceMs);
  }

  /** Never aborted: closing the connection would cost the next keystroke a new handshake. */
  private searchInstant() {
    if (this.instantInFlight >= 2) { this.instantQueued = true; return; }
    const query = this.state.query, sequence = ++this.instantSequence;
    this.instantInFlight++;
    searchSessionsInstant(query, AbortSignal.timeout(8000)).then(hits => {
      if (sequence < this.instantApplied || !this.remote()) return;
      this.instantApplied = sequence;
      // An older answer adds candidates; only the current one replaces them.
      this.keywordHits = query === this.state.query ? hits : [...this.keywordHits, ...hits];
      this.recompute(true);
    }, () => {}).finally(() => {
      this.instantInFlight--;
      if (!this.instantQueued) return;
      this.instantQueued = false;
      if (this.remote()) this.searchInstant();
    });
  }

  private loadPreview() {
    const session = this.selection();
    const key = session ? `${sessionKey(session)}:${session.updatedAt}` : "";
    if (key === this.previewKey) return;
    this.previewKey = key;
    clearTimeout(this.previewTimer);
    const revision = ++this.previewRevision;
    this.state.transcript = null;
    this.state.transcriptError = "";
    this.state.transcriptLoading = !!session;
    this.state.previewScroll = 0;
    if (!session) return;
    this.previewTimer = setTimeout(async () => {
      try {
        const transcript = await readTranscript(session);
        if (revision === this.previewRevision) this.state.transcript = transcript;
      } catch (error) {
        if (revision === this.previewRevision) this.state.transcriptError = String(error);
      } finally {
        if (revision === this.previewRevision) { this.state.transcriptLoading = false; this.draw(); }
      }
    }, 100);
  }

  private move(delta: number) {
    if (this.state.detailOpen || this.state.previewFocus || this.state.help) {
      const { inner, right, body } = this.layout();
      const detailWidth = this.state.detailOpen ? inner : right;
      const length = this.state.help ? HELP_LINES : detailLines(this.state, Math.max(1, detailWidth)).length;
      const visible = this.state.help ? body : detailViewportHeight(this.state, detailWidth, body);
      this.state.previewScroll = Math.max(0, Math.min(Math.max(0, length - visible), this.state.previewScroll + delta));
    } else {
      this.state.selected = Math.max(0, Math.min(this.state.results.length - 1, this.state.selected + delta));
      this.state.top = Math.max(0, Math.min(this.state.top, this.state.selected));
      if (this.state.selected >= this.state.top + this.listPage()) this.state.top = this.state.selected - this.listPage() + 1;
      this.loadPreview();
    }
    this.draw();
  }

  private onKey = (text: string | undefined, key: Key = {}) => {
    if (!this.active || this.resuming) return;
    if (key.name === "paste-start") { this.pasting = true; this.pasteBuffer = ""; return; }
    if (key.name === "paste-end") {
      this.pasting = false;
      this.state.query = (this.state.query + clean(this.pasteBuffer.replace(/[\r\n]+/g, " "))).slice(0, 2000);
      this.state.detailOpen = this.state.previewFocus = false;
      this.state.selected = 0;
      this.scheduleSearch(); return;
    }
    if (this.pasting) { this.pasteBuffer = (this.pasteBuffer + (text || "")).slice(0, 2000); return; }
    const ctrl = (name: string) => key.ctrl && key.name === name;
    if (ctrl("c") || ctrl("d")) { this.quit(); return; }
    if (key.name === "f1") { this.state.help = !this.state.help; this.state.previewScroll = 0; this.draw(); return; }
    if (key.name === "escape") {
      if (this.state.help || this.state.detailOpen || this.state.previewFocus) {
        this.state.help = this.state.detailOpen = this.state.previewFocus = false;
        this.state.previewScroll = 0;
      } else if (this.state.query) { this.state.query = ""; this.scheduleSearch(); }
      else this.quit();
      this.draw(); return;
    }
    if (key.name === "up" || ctrl("p")) { this.move(-1); return; }
    if (key.name === "down" || ctrl("n")) { this.move(1); return; }
    if (key.name === "pageup") { this.move(-this.listPage()); return; }
    if (key.name === "pagedown") { this.move(this.listPage()); return; }
    if (key.name === "home") { this.move(-Infinity); return; }
    if (key.name === "end") { this.move(Infinity); return; }
    if (this.state.help) return;
    if (key.name === "right") { if ((process.stdout.columns || 100) >= 100) this.state.previewFocus = true; this.draw(); return; }
    if (key.name === "left") { this.state.previewFocus = false; this.draw(); return; }
    if (key.name === "tab") {
      const filters = this.state.filters;
      const index = filters.indexOf(this.state.filter);
      this.state.filter = filters[(index + (key.shift ? filters.length - 1 : 1)) % filters.length];
      this.recompute(); return;
    }
    if (ctrl("t")) {
      this.state.detailOpen = !this.state.detailOpen;
      this.state.previewFocus = false;
      this.state.previewScroll = 0;
      this.draw(); return;
    }
    if (ctrl("r")) { void this.refresh(); return; }
    if (ctrl("l")) { this.state.localOnly = !this.state.localOnly; this.scheduleSearch(); return; }
    if (ctrl("y")) { void this.copyCommand(); return; }
    if (key.name === "return") { void this.resume(); return; }
    if (ctrl("u")) this.state.query = "";
    else if (ctrl("w")) this.state.query = this.state.query.trimEnd().replace(/\S+$/, "");
    else if (key.name === "backspace") this.state.query = dropLastGrapheme(this.state.query);
    else if (text && !key.ctrl && !key.meta && !/^\x1b/.test(text)) {
      this.state.query = (this.state.query + clean(text).replace(/[\r\n]/g, " ")).slice(0, 2000);
    } else return;
    this.state.detailOpen = this.state.previewFocus = false;
    this.state.selected = 0;
    this.scheduleSearch();
  };

  private async copyCommand() {
    const session = this.selection();
    if (!session) return;
    const command = buildShellSnippet(session.agent, session.id, session.cwd);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
        child.on("error", reject);
        child.stdin.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error("Clipboard unavailable")));
        child.stdin.end(command);
      });
      this.state.status = "Resume command copied";
    } catch (error) { this.state.status = String(error); }
    this.draw();
  }

  private async resume() {
    const session = this.selection();
    if (!session || this.resuming) return;
    this.resuming = true;
    const folder = await stat(session.cwd).catch(() => null);
    if (!folder?.isDirectory()) { this.resuming = false; this.state.status = `Project folder no longer exists: ${session.cwd}`; this.draw(); return; }
    const spec = resumeSpec(session);
    this.leave();
    // Separate argv and cwd preserve literal session IDs and paths without shell parsing.
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: "inherit" });
    child.once("error", error => {
      this.resuming = false;
      this.state.status = `Could not start ${spec.command}: ${error.message}`;
      this.enter();
    });
    child.once("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 0)));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  const options = optionsFor(argv);
  if (options.index) {
    if (requestContext() === null) throw new Error("set TURBOPUFFER_API_KEY to index transcripts");
    const sessions = await listSessions();
    const pending = (await staleSessions(sessions)).length;
    console.error(`Indexing ${pending} new or changed chats into ${namespaceName()}…`);
    const tty = process.stderr.isTTY;
    let progress;
    try {
      progress = await indexSessions(sessions, ({ processed, total, chunksUploaded, retryingUntil }) => {
        const waiting = retryingUntil === null ? "" : ` · rate limited, retrying in ${Math.max(1, Math.ceil((retryingUntil - Date.now()) / 1000))}s`;
        if (tty) process.stderr.write(`\r\x1b[K${processed}/${total} chats · ${chunksUploaded} chunks uploaded${waiting}`);
      });
    } catch (error) {
      if (tty) process.stderr.write("\n");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nProgress is saved. Run search-chats --index again to continue.`);
    }
    resetSearchContext();
    console.error(`${tty ? "\n" : ""}Done: ${progress.processed} chats, ${progress.chunksUploaded} chunks uploaded.`);
    return;
  }
  if (options.list) {
    const sessions = await listSessions();
    let hits: SearchHit[] = [];
    if (options.query.trim() && !options.local) {
      try { hits = await searchSessions(options.query, sessions, 100, AbortSignal.timeout(8000)); }
      catch (error) { console.error(`Transcript search unavailable; local matches shown. ${String(error)}`); }
    }
    const results = resultsFor(sessions, options.query, options.agent, hits);
    if (options.json) console.log(JSON.stringify(results.map(result => result.session), null, 2));
    else for (const { session } of results) {
      const fields = [`${AGENTS[session.agent].icon} ${AGENTS[session.agent].label}`, session.updatedAt, session.title, session.cwd];
      console.log(fields.map(field => clean(field).replace(/[\r\n]/g, " ")).join("\t"));
    }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the picker needs an interactive terminal; use --list or --json for piped output");
  await new SearchChats(options).run();
}

main().catch(error => { console.error(`search-chats: ${error.message}`); process.exitCode = 1; });
