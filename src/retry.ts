import { logger } from "./logger";

interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Backoff multiplier applied after each attempt. */
  factor: number;
  /** Cap for the computed delay, in milliseconds. */
  maxDelayMs: number;
  /** Random jitter added to each delay (±), in milliseconds. */
  jitterMs: number;
  /** Human-readable label for log lines. */
  label: string;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  factor: 2,
  maxDelayMs: 60_000,
  jitterMs: 500,
  label: "operation",
};

const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const RETRYABLE_ERROR_NAMES = new Set([
  "RequestTimeoutError",
  "ConnectionError",
  "UnexpectedClientError",
]);

/** True for transient failures worth retrying (rate limits, 5xx, network blips). */
function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
    // OpenRouter reports its PDF parsing engine rate limit as a 400 whose
    // message mentions the rate limit — catch that specifically.
    if (/rate limit/i.test(err.message)) return true;
  }
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run fn, retrying transient failures with exponential backoff + jitter. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const retryLogger = logger.child({ module: "retry", label: opts.label });

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts || !isRetryableError(err)) throw err;

      const backoffMs = Math.min(
        opts.baseDelayMs * opts.factor ** (attempt - 1),
        opts.maxDelayMs,
      );
      const jitterMs = Math.floor((Math.random() * 2 - 1) * opts.jitterMs);
      const delayMs = Math.max(0, backoffMs + jitterMs);

      retryLogger.warn(
        {
          attempt,
          maxAttempts: opts.maxAttempts,
          delayMs,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
        `Transient failure — retrying in ${(delayMs / 1000).toFixed(1)}s`,
      );
      await sleep(delayMs);
    }
  }
}
