/**
 * Which board cards changed since the viewer last saw the board (UI-R2): a card whose status differs, or a card that
 * was not there before. Nothing is reported on the first visit (no previous snapshot). Pure, for testing.
 */
export type BoardSnapshot = Record<string, string>;

export interface BoardChange {
  id: string;
  kind: "moved" | "new";
}

export function boardChanges(previous: BoardSnapshot | null, current: BoardSnapshot): BoardChange[] {
  if (!previous) return [];
  const changes: BoardChange[] = [];
  for (const [id, status] of Object.entries(current)) {
    if (!Object.hasOwn(previous, id)) changes.push({ id, kind: "new" });
    else if (previous[id] !== status) changes.push({ id, kind: "moved" });
  }
  return changes;
}

export function parseSnapshot(raw: string | null): BoardSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}
