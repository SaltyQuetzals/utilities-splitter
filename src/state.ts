import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

const STATE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".utilities-splitter-state.json",
);

export interface State {
  /** YYYY-MM-DD of the last successfully OCR'd bill, or null. */
  lastBillDate: string | null;
  /** Hex-encoded SHA-256 of the last OCR'd first-page PDF, or null. */
  lastPdfHash: string | null;
}

export function computePdfHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function loadState(): Promise<State> {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return {
      lastBillDate: parsed.lastBillDate ?? null,
      lastPdfHash: parsed.lastPdfHash ?? null,
    };
  } catch {
    return { lastBillDate: null, lastPdfHash: null };
  }
}

export async function saveState(state: State): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  logger.info(
    { stateFile: STATE_FILE, lastBillDate: state.lastBillDate },
    "State saved",
  );
}
