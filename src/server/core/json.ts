import { createHash } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Two payloads that mean the
 * same thing produce the same string, so their hashes match (idempotency, approval snapshots).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers cannot be serialised");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const maybe = value as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === "function") {
      return normalize(maybe.toJSON());
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        result[key] = normalize(child);
      }
    }
    return result;
  }
  throw new TypeError(`Cannot serialise value of type ${typeof value}`);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
