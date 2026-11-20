import { AGENTS, type AgentFilter, type ChatResult } from "./model";
import { formatAbsoluteTime, formatRelativeTime, shortenHomePath } from "./services/format";
import type { TranscriptResult } from "./services/session-types";
import { clip, pad, width, wrapRich, renderRich, type RichLine, type MatchRange, type TextTone } from "./terminal";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[38;5;243m";
const FAINT = "\x1b[38;5;238m";
const TEXT = "\x1b[38;5;252m";
const BRIGHT = "\x1b[1;38;5;231m";
const ACCENT = "\x1b[38;5;80m";
const WARN = "\x1b[38;5;215m";
const SELECTED = "\x1b[48;5;236m";
type Segment = [text: string, style?: string];
/** Each segment restates the row background so a style change never clears it. */
const paint = (segments: Segment[], background = "") =>
  segments.map(([text, style = ""]) => `${RESET}${background}${style}${text}`).join("") + RESET;

export interface ViewState {
  query: string;
  filter: AgentFilter;
  filters: AgentFilter[];
  results: ChatResult[];
  total: number;
  selected: number;
  top: number;
  loading: boolean;
  searching: boolean;
  localOnly: boolean;
  status: string;
  transcript: TranscriptResult | null;
  transcriptLoading: boolean;
  transcriptError: string;
  detailOpen: boolean;
  previewFocus: boolean;
  previewScroll: number;
  help: boolean;
}

/** One place for the geometry shared by rendering and scrolling. */
export function layout(columns: number, rows: number) {
  const inner = Math.max(1, columns - 5); // Two-column margins; the last column stays free to avoid autowrap.
  const split = columns >= 100;
  const left = split ? Math.floor((inner - 3) * 0.45) : inner;
  return { inner, body: Math.max(1, rows - 4), split, left, right: inner - left - 3 };
}

export function detailLines(state: ViewState, columns: number): string[] {
  return detailContent(state, columns).map(line => line.text);
}

/** Format message blocks without changing the server's source match offsets. */
function messageContent(text: string, matches: MatchRange[], columns: number, accent: TextTone): RichLine[] {
  const lines: RichLine[] = [];
  const contentWidth = Math.max(1, columns - 2);
  let offset = 0, code = false;
  for (const raw of text.split("\n")) {
    const fence = raw.match(/^\s*```(.*)/);
    if (fence) {
      code = !code;
      lines.push({ text: code ? fence[1].trim() || "code" : "─".repeat(contentWidth), matches: [], tone: "muted", prefix: "┊ ", prefixTone: "rule" });
    } else {
      const heading = !code && raw.match(/^\s{0,3}#{1,6}\s+/);
      const list = !code && raw.match(/^\s*[-*+]\s+/);
      const quote = !code && raw.match(/^>\s?/);
      const removed = heading ? heading[0].length : list ? list[0].length : quote ? quote[0].length : 0;
      const bullet = list ? "• " : "";
      const ranges = matches.flatMap(([from, to]) => {
        const start = Math.max(from - offset - removed, 0), end = Math.min(to - offset - removed, raw.length - removed);
        return end > start ? [[start, end] as MatchRange] : [];
      });
      const wrapped = wrapRich(raw.slice(removed), ranges, Math.max(1, contentWidth - width(bullet)));
      lines.push(...wrapped.map((line, index) => ({ ...line,
        tone: code ? "code" as const : heading ? "title" as const : quote ? "muted" as const : undefined,
        prefix: `${code ? "┊" : "│"} ${index === 0 ? bullet : " ".repeat(width(bullet))}`,
        prefixTone: code ? "rule" as const : accent,
      })));
    }
    offset += raw.length + 1;
  }
  return lines;
}

export function detailContent(state: ViewState, columns: number): RichLine[] {
  const result = state.results[state.selected];
  if (!result) return [];
  const { session, hit } = result;
  const provider = AGENTS[session.agent];
  const lines: RichLine[] = [];
  const add = (text: string, tone?: TextTone) => lines.push(...wrapRich(text, [], columns).map(line => ({ ...line, tone })));
  const section = (label: string, tone: TextTone) => {
    add(`${label} ${"─".repeat(Math.max(0, columns - width(label) - 1))}`, tone);
  };
  add(session.title, "title");
  add(`${provider.icon} ${provider.label} · ${session.projectName}`, session.agent);
  const relative = formatRelativeTime(session.updatedAt), absolute = formatAbsoluteTime(session.updatedAt);
  // Older chats already show a date as their relative time.
  add(absolute.startsWith(relative) ? absolute : `${relative} ago · ${absolute}`, "muted");
  add("");
  if (!state.detailOpen) {
    const opening = state.transcript?.items.find(item => item.kind === "message" && item.role === "user");
    const text = opening?.kind === "message" ? opening.text : session.preview || session.title;
    section("OPENING MESSAGE", "opening");
    const openingLines = messageContent(text, [], columns, "opening");
    // Keep the matched passage visible even when the original prompt is long.
    const limit = hit?.snippet ? 4 : 8;
    if (openingLines.length > limit) {
      lines.push(...openingLines.slice(0, limit)); add("  … Ctrl-T for the full opening message", "muted");
    } else lines.push(...openingLines);
    add("");
  }
  if (hit?.snippet) {
    const accent = hit.matches.length ? "match" : "semantic";
    section(hit.matches.length ? "MATCHING PASSAGE" : "RELATED PASSAGE · semantic", accent);
    lines.push(...messageContent(hit.snippet, hit.matches, columns, accent)); add("");
  }
  if (state.transcriptLoading) add("Reading transcript…", "muted");
  else if (state.transcriptError) add(`Cannot read transcript: ${state.transcriptError}`, "muted");
  else if (state.transcript && state.detailOpen) {
    const transcript = state.transcript;
    section(`TRANSCRIPT · ${transcript.messageCount} messages`, "muted"); add("");
    for (const item of transcript.items) {
      if (item.kind === "gap") add(`… ${item.omittedCount} entries omitted …`, "muted");
      else if (item.kind === "tools") add(`↳ ${item.names.join(" · ")}`, "muted");
      else {
        const accent = item.role === "user" ? "opening" : session.agent;
        section(item.role === "user" ? "YOU" : `${provider.icon} ${provider.label.toUpperCase()}`, accent);
        lines.push(...messageContent(item.text, [], columns, accent));
      }
      add("");
    }
    if (transcript.truncated) add("Long transcript: showing the first and last 150 entries.", "muted");
  }
  return lines;
}

function detailFooter(state: ViewState, columns: number, rows: number): RichLine[] {
  const session = state.results[state.selected]?.session;
  // Leave room for the message in very short terminals.
  if (!session || rows < 8) return [];
  const extra = [session.gitBranch ? `Branch · ${session.gitBranch}` : "", session.archived ? "Archived session" : ""].filter(Boolean);
  return [
    { text: "─".repeat(columns), matches: [], tone: "rule" },
    ...[shortenHomePath(session.cwd), ...extra.slice(0, rows - 7), session.id]
      .map(text => ({ text, matches: [], tone: "muted" as const })),
  ];
}

export function detailViewportHeight(state: ViewState, columns: number, rows: number): number {
  const footer = detailFooter(state, columns, rows);
  return Math.max(1, rows - footer.length - (footer.length ? 1 : 0));
}

function detailViewport(state: ViewState, columns: number, rows: number): RichLine[] {
  const content = detailContent(state, columns);
  const height = detailViewportHeight(state, columns, rows);
  const scroll = Math.max(0, Math.min(state.previewScroll, content.length - height));
  const lines = Array.from({ length: height }, (_, i) => content[scroll + i] ?? { text: "", matches: [] });
  const footer = detailFooter(state, columns, rows);
  if (footer.length) lines.push({ text: "", matches: [] }, ...footer);
  return lines;
}

const KEYS: [string, string][] = [
  ["type", "Search titles, projects, branches, IDs, and transcripts"],
  ["↑ ↓  ^P ^N", "Select a chat"],
  ["enter", "Resume here, in the original project folder"],
  ["tab  shift-tab", "Cycle through agents"],
  ["^T", "Open or close the full transcript"],
  ["→ ←", "Focus the preview or the chat list"],
  ["pgup pgdn  home end", "Page or jump; scrolls a focused preview"],
  ["^Y", "Copy the resume command"],
  ["^R", "Scan for new and updated chats"],
  ["^L", "Toggle local-only search"],
  ["^U  ^W", "Clear the search or its last word"],
  ["esc", "Back, clear the search, then quit"],
  ["^C  ^D", "Quit"],
];
const HELP: Segment[][] = [
  ...KEYS.map(([keys, action]): Segment[] => [[pad(keys, 22), TEXT], [action, DIM]]),
  [],
  [["Results are always newest first. ", DIM], ["≈", TEXT], [" marks a chat matched inside its transcript.", DIM]],
  [["Keyword matches appear as you type; semantic matches follow after a short pause.", DIM]],
];
export const HELP_LINES = HELP.length;

const HINTS: Record<"list" | "preview" | "help", [string, string][]> = {
  list: [["↵", "resume"], ["tab", "agent"], ["^T", "transcript"], ["^Y", "copy"], ["F1", "keys"], ["esc", "quit"]],
  preview: [["↑↓", "scroll"], ["pgup/pgdn", "page"], ["↵", "resume"], ["esc", "back"]],
  help: [["↑↓", "scroll"], ["esc", "back"]],
};

/** Left and right segments on one line; the right side wins when space is short. */
function spread(left: Segment[], right: Segment[], columns: number): string {
  const rightWidth = right.reduce((n, [text]) => n + width(text), 0);
  let budget = Math.max(0, columns - rightWidth - (rightWidth ? 2 : 0));
  const fitted: Segment[] = [];
  for (const [text, style] of left) {
    const clipped = clip(text, budget);
    fitted.push([clipped, style]);
    budget -= width(clipped);
  }
  return paint([...fitted, [" ".repeat(budget + (rightWidth ? 2 : 0))], ...right]);
}

/** A fixed-height frame; user-controlled content can never emit terminal controls. */
export function render(state: ViewState, columns: number, rows: number): string {
  if (rows < 10 || columns < 40) {
    const tiny = ["Search Chats", "Resize to at least 40 × 10.", "Ctrl-C to quit."];
    return tiny.slice(0, rows).map(s => clip(s, Math.max(1, columns - 1))).join("\r\n");
  }
  const { inner, body, split, left, right } = layout(columns, rows);
  const frame: string[] = [""];
  const line = (content: string) => frame.push(`  ${content}`);

  const tabs: Segment[] = inner < 70 || state.filters.length < 3 ? [] : state.filters.flatMap((filter, index): Segment[] => {
    const label = filter === "all" ? "All" : AGENTS[filter].label;
    const style = state.filter !== filter ? DIM : filter === "all" ? BRIGHT : BOLD + AGENTS[filter].color;
    return [[label, style], [index === state.filters.length - 1 ? "    " : "  "]];
  });
  const shown = state.results.length;
  const count = state.loading && !state.total ? "reading chats…"
    : shown === state.total ? `${shown} chats` : `${shown} of ${state.total}`;
  line(spread(
    state.query
      ? [["❯ ", BOLD + ACCENT], [clip(state.query, Math.max(1, inner - 40)), BRIGHT], [" ", "\x1b[7m"]]
      : [["❯ ", BOLD + ACCENT], ["Search chats…", DIM]],
    [...tabs, [count, DIM]], inner,
  ));
  line(paint([["─".repeat(inner), FAINT]]));

  if (state.help) {
    for (let i = 0; i < body; i++) line(spread(HELP[state.previewScroll + i] ?? [], [], inner));
  } else if (state.detailOpen) {
    const lines = detailViewport(state, inner, body);
    for (let i = 0; i < body; i++) line(renderRich(lines[i] ?? { text: "", matches: [] }, inner));
  } else {
    const details = split ? detailViewport(state, right, body) : [];
    const list: string[] = [];
    for (let i = 0; i < body; i++) {
      const index = state.top + i;
      const entry = state.results[index];
      if (!entry) { list.push(" ".repeat(left)); continue; }
      const { session } = entry;
      const provider = AGENTS[session.agent];
      const selected = index === state.selected;
      const age = formatRelativeTime(session.updatedAt);
      // The project is the first thing to go when the list is narrow.
      const project = left >= 56 ? clip(`${entry.local ? "" : "≈ "}${session.projectName}${session.archived ? " · archived" : ""}`, 22) : entry.local ? "" : "≈";
      const meta = [project, age].filter(Boolean).join("  ");
      const title = pad(session.title, Math.max(1, left - width(meta) - 6));
      list.push(paint([
        [selected ? "▌" : " ", provider.color], [` ${provider.icon} `, provider.color],
        [title, selected ? BRIGHT : TEXT], [`  ${meta} `, DIM],
      ], selected ? SELECTED : ""));
    }
    if (!state.loading && !shown) {
      list[1] = paint([[pad(state.query ? "  No matching chats" : "  No chats found", left), TEXT]]);
      list[2] = paint([[pad(state.query ? "  esc clears the search" : "  ^R scans again", left), DIM]]);
    }
    const divider = paint([[" │ ", state.previewFocus ? ACCENT : FAINT]]);
    for (let i = 0; i < body; i++) {
      line(list[i] + (split ? divider + renderRich(details[i] ?? { text: "", matches: [] }, right) : ""));
    }
  }

  const mode = state.help ? "help" : state.detailOpen || state.previewFocus ? "preview" : "list";
  const hints = HINTS[mode].flatMap(([key, action]): Segment[] => [[key, TEXT], [` ${action}   `, DIM]]);
  const notes = [
    state.searching ? "searching…" : "", state.localOnly ? "local only" : "",
    shown && mode !== "help" ? `${state.selected + 1}/${shown}` : "",
  ].filter(Boolean).join("  ·  ");
  line(spread(state.status ? [[state.status, WARN]] : hints, [[notes, DIM]], inner));
  return frame.slice(0, rows).join("\r\n") + RESET;
}
