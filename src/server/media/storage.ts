import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where photo bytes live. Development and tests use the local disk; production gets a private
 * object store with short-lived signed URLs in Increment 5 (GAP-42, region per V-1). Keys are
 * content-addressed, so writing the same photo twice is harmless.
 *
 * Writing happens before the recording command (rule 3: no external side effects inside a
 * command). A command that then fails leaves an unreferenced file, never a reference to a
 * missing one.
 */
export interface MediaStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

// Lowercase path segments with an extension; ".." is refused separately.
const KEY = /^[a-z0-9][a-z0-9/_.-]{0,199}$/;

export class LocalDiskStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY.test(key) || key.includes("..")) throw new Error(`Invalid storage key ${key}`);
    return join(this.root, key);
  }

  /**
   * Never rewrites an existing file: keys are content-addressed, so an existing file already holds
   * these bytes (and may be locked evidence). New files are written to a temporary name and renamed,
   * so a crash or a full disk never leaves a partial file under the real key.
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    if (await exists(path)) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Key for a photo: sha256 split into a two-level directory, with the type's extension. */
export function photoKey(sha256: string, contentType: string): string {
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  return `photos/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

let defaultStorage: MediaStorage | undefined;

/** The app's storage: MEDIA_DIR, or .data/media (git-ignored) in development. */
export function getMediaStorage(): MediaStorage {
  defaultStorage ??= new LocalDiskStorage(process.env.MEDIA_DIR ?? join(process.cwd(), ".data", "media"));
  return defaultStorage;
}
