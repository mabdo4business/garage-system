/**
 * Minimal structured logger with mandatory redaction.
 * Passwords, tokens, PINs, cookies and authorization headers never reach log output (NFR-20).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;

const SENSITIVE_KEY = /pass(word)?|token|secret|authori[sz]ation|cookie|pin|otp|credential/i;
export const REDACTED = "[REDACTED]";

let sink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Replaces the output sink. Returns a function that restores the previous sink (used by tests). */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(child, depth + 1);
  }
  return result;
}

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  sink(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...(redact(fields) as Record<string, unknown>),
    }),
  );
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
