import { performance } from "node:perf_hooks";

/**
 * Stateful JSONL compaction for Pi `--mode json` stdout before it enters
 * the Paperclip run-log pipeline.
 *
 * Pi emits `message_update` events that repeat the FULL cumulative assistant
 * message on every streaming delta. Persisting each line makes run-log size
 * grow ~quadratically. In `compact` mode, stripping the cumulative copies
 * keeps growth linear without changing `parsePiJsonl` output or UI live typing.
 *
 * No truncation here: it would run before the server's secret redaction and
 * can split a secret across the cut boundary. The server re-caps after
 * redaction; oversized content is its responsibility.
 *
 * Non-JSON lines and unknown event types pass through unchanged. Compacting
 * modes preserve terminal data, sometimes in slimmed form, and replace tool
 * update streams with throttled Paperclip progress events so the stale-run
 * watchdog's `lastOutputAt` stays fresh during long tool runs.
 */

export type PiStdoutLogMode = "raw" | "compact" | "metadata-only";

export const PI_STDOUT_LOG_MODES: readonly PiStdoutLogMode[] = ["raw", "compact", "metadata-only"];

export const DEFAULT_PI_STDOUT_LOG_MODE: PiStdoutLogMode = "compact";

const PROGRESS_INTERVAL_MS = 5_000;

const METADATA_ONLY_DROPPED_TYPES = new Set([
  "message_start",
  "message_end",
  "turn_start",
  "queue_update",
  "agent_settled",
]);

export function resolvePiStdoutLogMode(config: Record<string, unknown>): PiStdoutLogMode {
  if (config.stdoutLogMode === undefined || config.stdoutLogMode === null) {
    return DEFAULT_PI_STDOUT_LOG_MODE;
  }
  if (typeof config.stdoutLogMode !== "string") return "raw";
  const normalized = config.stdoutLogMode.trim().toLowerCase();
  if (normalized === "raw" || normalized === "compact" || normalized === "metadata-only") {
    return normalized;
  }
  // Invalid explicit values fail safe to the lossless legacy stream rather
  // than silently enabling a lossy transformation.
  return "raw";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLineEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(event) ? event : null;
}

function slimAssistantMessageEvent(update: unknown): unknown {
  if (!isRecord(update)) return update;
  const { partial: _partial, ...rest } = update;
  return rest;
}

function compactAssistantMessage(message: unknown): unknown {
  if (!isRecord(message)) return message;
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.filter(
      (part) => !(isRecord(part) && part.type === "thinking"),
    ),
  };
}

type Clock = () => number;

function createThrottle(intervalMs: number, now: Clock): () => boolean {
  let lastAt: number | null = null;
  return () => {
    const current = now();
    if (lastAt !== null && current >= lastAt && current - lastAt < intervalMs) return false;
    // A backwards clock jump starts a fresh interval instead of suppressing
    // liveness until wall time catches up. Production uses a monotonic clock;
    // this branch also makes injected/test clocks fail safe.
    lastAt = current;
    return true;
  };
}

function compactUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usage)) return undefined;
  const compacted: Record<string, unknown> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (typeof usage[key] === "number") compacted[key] = usage[key];
  }
  if (isRecord(usage.cost)) {
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      if (typeof usage.cost[key] === "number") cost[key] = usage.cost[key];
    }
    if (Object.keys(cost).length > 0) compacted.cost = cost;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

/** Drops bulk content (thinking, diagnostics) from object-shaped Pi errors while keeping diagnostic metadata. */
function compactAssistantError(error: unknown): unknown {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return undefined;

  const compacted: Record<string, unknown> = {};
  for (const key of [
    "role",
    "api",
    "provider",
    "model",
    "responseModel",
    "responseId",
    "stopReason",
    "errorMessage",
  ] as const) {
    if (typeof error[key] === "string") compacted[key] = error[key];
  }
  if (typeof error.timestamp === "number") compacted.timestamp = error.timestamp;
  const usage = compactUsage(error.usage);
  if (usage) compacted.usage = usage;
  return compacted;
}

// Emitted with a `paperclip_` prefix so consumers can tell it isn't a Pi event.
function progressTick(
  sourceEventType: "message_update" | "tool_execution_update",
  allow: () => boolean,
  toolCallId?: unknown,
): string | null {
  if (!allow()) return null;
  return JSON.stringify({
    type: "paperclip_progress",
    sourceEventType,
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
  });
}

export interface PiStdoutCompactor {
  /** Returns the (possibly transformed) line to log, or `null` to drop it. */
  (line: string): string | null;
}

export interface PiStdoutCompactorOptions {
  /** Monotonic clock by default; injectable for deterministic throttle tests. */
  now?: Clock;
}

function createCompactCompactor(now: Clock): PiStdoutCompactor {
  const allowToolTick = createThrottle(PROGRESS_INTERVAL_MS, now);
  return (line) => {
    const event = parseLineEvent(line);
    if (!event) return line;

    if (event.type === "tool_execution_update") {
      return progressTick("tool_execution_update", allowToolTick, event.toolCallId);
    }
    if (event.type !== "message_update") return line;

    const { message: _cumulativeMessage, ...rest } = event;
    return JSON.stringify({
      ...rest,
      ...(event.assistantMessageEvent !== undefined
        ? { assistantMessageEvent: slimAssistantMessageEvent(event.assistantMessageEvent) }
        : {}),
    });
  };
}

function createMetadataOnlyCompactor(now: Clock): PiStdoutCompactor {
  const allowMsgTick = createThrottle(PROGRESS_INTERVAL_MS, now);
  const allowToolTick = createThrottle(PROGRESS_INTERVAL_MS, now);
  return (line) => {
    const event = parseLineEvent(line);
    if (!event) return line;

    const type = typeof event.type === "string" ? event.type : "";

    if (METADATA_ONLY_DROPPED_TYPES.has(type)) return null;

    if (type === "tool_execution_update") {
      return progressTick("tool_execution_update", allowToolTick, event.toolCallId);
    }

    if (type === "message_update") {
      const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
      if (update?.type === "error") {
        // Streaming errors are finalized: keep diagnostic fields, drop content/thinking.
        const error = compactAssistantError(update.error);
        return JSON.stringify({
          type: "paperclip_error",
          sourceEventType: "message_update",
          ...(typeof update.reason === "string" ? { reason: update.reason } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      }
      return progressTick("message_update", allowMsgTick);
    }

    if (type === "turn_end") {
      // Metadata-only deliberately whitelists top-level terminal fields;
      // unknown Pi additions may contain bulk data that this mode should drop.
      return JSON.stringify({
        type: "turn_end",
        message: compactAssistantMessage(event.message),
        toolResults: [], // Final tool results are retained on tool_execution_end.
      });
    }

    if (type === "agent_end") {
      // Keep only the last assistant message: this is what bounds log size,
      // and it carries the final text + usage summary.
      const messages = Array.isArray(event.messages) ? event.messages : [];
      let lastAssistantMessage: Record<string, unknown> | null = null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (isRecord(message) && message.role === "assistant") {
          lastAssistantMessage = message;
          break;
        }
      }
      const kept = lastAssistantMessage ? [compactAssistantMessage(lastAssistantMessage)] : [];
      return JSON.stringify({
        type: "agent_end",
        ...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}),
        messages: kept,
      });
    }

    return line;
  };
}

export function createPiStdoutCompactor(
  mode: PiStdoutLogMode,
  options: PiStdoutCompactorOptions = {},
): PiStdoutCompactor {
  const now = options.now ?? (() => performance.now());
  switch (mode) {
    case "raw":
      return (line) => line;
    case "compact":
      return createCompactCompactor(now);
    case "metadata-only":
      return createMetadataOnlyCompactor(now);
  }
}
