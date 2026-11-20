// All transcript and filesystem text passes through this module before rendering.
import { AGENTS } from "./model";
import type { AgentKind } from "./services/session-types";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /\p{Extended_Pictographic}/u;
const mark = /^\p{Mark}$/u;

export function clean(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "  ");
}

function graphemeWidth(value: string): number {
  const cp = value.codePointAt(0) ?? 0;
  if (cp === 0 || mark.test(value)) return 0;
  if ((cp >= 0x1f1e6 && cp <= 0x1f1ff) || value.includes("\u20e3")) return 2;
  if (emoji.test(value) && (value.includes("\ufe0f") || cp >= 0x1f000)) return 2;
  return (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000
  )) ? 2 : 1;
}

export function width(value: string): number {
  return [...segments.segment(clean(value))].reduce((n, s) => n + graphemeWidth(s.segment), 0);
}

export function clip(value: string, columns: number, ellipsis = true): string {
  const text = clean(value).replace(/[\r\n]/g, " ");
  if (columns <= 0) return "";
  if (width(text) <= columns) return text;
  const budget = columns - (ellipsis ? 1 : 0);
  let output = "", used = 0;
  for (const { segment } of segments.segment(text)) {
    const size = graphemeWidth(segment);
    if (used + size > budget) break;
    output += segment;
    used += size;
  }
  return output + (ellipsis ? "…" : "");
}

export function pad(value: string, columns: number): string {
  const text = clip(value, columns);
  return text + " ".repeat(Math.max(0, columns - width(text)));
}

export function wrap(value: string, columns: number): string[] {
  const lines: string[] = [];
  for (const raw of clean(value).replace(/\r/g, "").split("\n")) {
    let current = "", used = 0;
    for (const { segment } of segments.segment(raw)) {
      const size = graphemeWidth(segment);
      if (used + size > Math.max(1, columns)) {
        lines.push(current);
        current = ""; used = 0;
      }
      current += segment; used += size;
    }
    lines.push(current);
  }
  return lines;
}

export function dropLastGrapheme(text: string): string {
  const all = [...segments.segment(text)];
  return text.slice(0, all.at(-1)?.index ?? 0);
}

export type MatchRange = [number, number];
export type TextTone = "title" | "muted" | "rule" | "opening" | "match" | "semantic" | "code" | AgentKind;
export interface RichLine {
  text: string;
  matches: MatchRange[];
  tone?: TextTone;
  prefix?: string;
  prefixTone?: TextTone;
}
const TONES: Record<TextTone, string> = {
  title: "\x1b[1;38;5;255m", muted: "\x1b[38;5;245m", rule: "\x1b[38;5;239m",
  opening: "\x1b[1;38;5;80m", match: "\x1b[1;38;5;222m", semantic: "\x1b[1;38;5;147m",
  code: "\x1b[38;5;152;48;5;235m",
  codex: AGENTS.codex.color, "claude-code": AGENTS["claude-code"].color,
  cursor: AGENTS.cursor.color, devin: AGENTS.devin.color,
};
export const MATCH_STYLE = "\x1b[1;38;5;16;48;5;222m";

/** Strip terminal controls while preserving the server's UTF-16 match offsets. */
function sanitizeRich(value: string, matches: MatchRange[]): RichLine {
  const removals = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|\t/g;
  const offsets = new Array<number>(value.length + 1);
  let output = "", cursor = 0;
  for (const match of value.matchAll(removals)) {
    const start = match.index;
    for (; cursor < start; cursor++) { offsets[cursor] = output.length; output += value[cursor]; }
    const replacement = match[0] === "\t" ? "  " : "";
    for (let i = 0; i < match[0].length; i++) offsets[cursor++] = output.length;
    output += replacement;
  }
  for (; cursor < value.length; cursor++) { offsets[cursor] = output.length; output += value[cursor]; }
  offsets[value.length] = output.length;
  return { text: output, matches: matches.flatMap(([from, to]) => {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
    const start = offsets[Math.max(0, Math.min(value.length, from))];
    const end = offsets[Math.max(0, Math.min(value.length, to))];
    return end > start ? [[start, end] as MatchRange] : [];
  }) };
}

/** Wrap before adding our own ANSI styling, so clipping cannot erase highlights. */
export function wrapRich(value: string, matches: MatchRange[], columns: number): RichLine[] {
  const safe = sanitizeRich(value, matches);
  const lines: RichLine[] = [];
  let text = "", used = 0, start = 0;
  const flush = () => {
    const end = start + text.length;
    lines.push({ text, matches: safe.matches.flatMap(([a, b]) => {
      const from = Math.max(a, start), to = Math.min(b, end);
      return to > from ? [[from - start, to - start] as MatchRange] : [];
    }) });
    start = end; text = ""; used = 0;
  };
  for (const { segment } of segments.segment(safe.text)) {
    if (segment === "\n") { flush(); start++; continue; }
    const size = graphemeWidth(segment);
    if (used + size > Math.max(1, columns)) {
      // Prefer a word boundary, retaining original offsets for native highlights.
      const boundary = text.lastIndexOf(" ");
      if (boundary > 0 && width(text.slice(0, boundary)) >= columns * 0.5) {
        const rest = text.slice(boundary + 1);
        text = text.slice(0, boundary);
        flush(); start++; text = rest; used = width(rest);
      } else flush();
    }
    text += segment; used += size;
  }
  flush();
  return lines;
}

export function renderRich(line: RichLine, columns: number): string {
  const safe = sanitizeRich(line.text, line.matches);
  const prefix = clip(line.prefix ?? "", columns, false);
  const budget = Math.max(0, columns - width(prefix));
  const text = clip(safe.text, budget);
  const base = line.tone ? TONES[line.tone] : "";
  let output = (prefix ? `${line.prefixTone ? TONES[line.prefixTone] : ""}${prefix}\x1b[0m` : "") + base;
  let highlighted = false;
  for (const { segment, index } of segments.segment(text)) {
    const match = safe.matches.some(([from, to]) => from < index + segment.length && to > index);
    if (match !== highlighted) output += match ? MATCH_STYLE : "\x1b[0m" + base;
    output += segment;
    highlighted = match;
  }
  return output + " ".repeat(Math.max(0, budget - width(text))) + "\x1b[0m";
}
