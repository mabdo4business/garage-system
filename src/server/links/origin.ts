import { ConflictError } from "../core/errors";

/**
 * The address customers open links on (T-46). Set `PUBLIC_BASE_URL` (e.g. https://garage.example) in every deployed
 * environment (I5-09): the staff device may reach the app by localhost, a LAN address or a preview host the customer
 * cannot open, and request headers can be spoofed. Only outside production, with nothing configured, the address the
 * request came in on is used (development). Otherwise a link is not made at all rather than sent broken.
 */
export function publicOrigin(requestOrigin: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    const url = safeUrl(configured);
    if (!url || url.pathname !== "/" || url.search || url.hash) {
      throw new ConflictError(
        "public_url_missing",
        "PUBLIC_BASE_URL must be an http(s) origin such as https://garage.example",
      );
    }
    return url.origin;
  }
  const fallback = requestOrigin ? safeUrl(requestOrigin) : null;
  if (env.NODE_ENV !== "production" && fallback) return fallback.origin;
  throw new ConflictError("public_url_missing", "The address customers open links on is not configured");
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
