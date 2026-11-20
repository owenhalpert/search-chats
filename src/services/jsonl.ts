/**
 * Helpers for reading JSON Lines transcripts.
 *
 * Claude Code and Codex logs total hundreds of megabytes, so list summaries are
 * built from bounded head/tail reads instead of parsing whole files.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  // Every record is a JSON object; skip partial or blank lines cheaply.
  if (line.charCodeAt(0) !== 0x7b) return null;
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

export function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EdgeLines {
  headLines: string[];
  tailLines: string[];
}

/**
 * Read the first `headBytes` and last `tailBytes` of a JSONL file as whole lines.
 * The head carries session metadata and the opening prompt; the tail carries the
 * most recent generated title and activity.
 */
export async function readEdgeLines(
  filePath: string,
  sizeBytes: number,
  headBytes: number,
  tailBytes: number,
): Promise<EdgeLines> {
  const handle = await fs.open(filePath, "r");
  try {
    const headLength = Math.min(sizeBytes, headBytes);
    let headText = "";
    if (headLength > 0) {
      const headBuffer = Buffer.allocUnsafe(headLength);
      await handle.read(headBuffer, 0, headLength, 0);
      headText = headBuffer.toString("utf8");
    }
    const headLines = toLines(headText, sizeBytes > headLength);

    let tailLines: string[] = [];
    if (sizeBytes > headBytes) {
      const tailLength = Math.min(sizeBytes - headBytes, tailBytes);
      const tailBuffer = Buffer.allocUnsafe(tailLength);
      await handle.read(tailBuffer, 0, tailLength, sizeBytes - tailLength);
      // The first line of a tail read is almost always a partial record.
      tailLines = toLines(tailBuffer.toString("utf8"), false).slice(1);
    }

    return { headLines, tailLines };
  } finally {
    await handle.close();
  }
}

/** Stream a file's lines so whole transcripts never sit in memory at once. */
export async function* readLines(filePath: string): AsyncGenerator<string> {
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length > 1) yield line;
  }
}

function toLines(text: string, dropTrailingPartial: boolean): string[] {
  const lines = text.split("\n");
  if (dropTrailingPartial) lines.pop();
  return lines.filter((line) => line.length > 1);
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await worker(item);
      }
    },
  );

  await Promise.all(runners);
  return results;
}
