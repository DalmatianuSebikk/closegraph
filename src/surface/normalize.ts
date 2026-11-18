/**
 * Pure normalization for the black-box surface family.
 *
 * Identity rules (binding, from the design):
 * - target  = hostname + non-default port; scheme/path/query stripped; host lowercased.
 * - endpoint path = route template: id-ish segments collapse to {id}; query/fragment excluded.
 * - page url = origin + path; query/fragment dropped. Pages do NOT collapse id segments:
 *   a page is a concrete screen, an endpoint is a route template — /users/123 and
 *   /users/456 are different pages but the same endpoint route. (Plan ruling, ledgered.)
 */

const DEFAULT_PORTS = new Set(["80", "443"]);
const LOGIN_SEGMENT = /^(login|signin|sign-in|auth|sso|oauth)$/i;

function splitPathIdentity(input: string): string {
  const cut = Math.min(
    ...[input.indexOf("?"), input.indexOf("#")].filter((i) => i >= 0).concat([input.length]),
  );
  return input.slice(0, cut);
}

function isIdLike(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) {
    return true; // uuid
  }
  if (/^[0-9a-fA-F]{8,}$/.test(segment)) return true; // hex >= 8
  if (
    segment.length >= 8 &&
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    /[-_]/.test(segment) &&
    (/\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment)))
  ) {
    return true; // base64ish token
  }
  return false;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed escape — keep raw
  }
}

function mapPathSegments(path: string, map: (segment: string, index: number) => string): string {
  const segments = path.split("/").map((s, i) => (i === 0 && s === "" ? s : map(decodeSegment(s), i)));
  while (segments.length > 1 && segments[segments.length - 1] === "") segments.pop(); // trailing slash
  return segments.length > 1 ? segments.join("/") : "/";
}

/** "https://App.ACME.com/" -> "app.acme.com"; "app.acme.com:8443" keeps port;
 *  default ports (80/443 — scheme ignored) dropped. Throws on unparseable input. */
export function normalizeTarget(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  let port: string;
  try {
    const url = new URL(withScheme);
    hostname = url.hostname.toLowerCase();
    port = url.port;
  } catch {
    throw new Error(`invalid target: ${input}`);
  }
  if (hostname.length === 0) throw new Error(`invalid target: ${input}`);
  return port && !DEFAULT_PORTS.has(port) ? `${hostname}:${port}` : hostname;
}

/** Route-template identity: id-ish segments -> {id}; trailing slash dropped (root stays "/");
 *  query/fragment excluded; segments URL-decoded before testing. */
export function normalizeEndpointPath(path: string): string {
  const identity = splitPathIdentity(path);
  if (identity.length === 0) return "/";
  if (!identity.startsWith("/")) return identity; // relative — return as-is, caller decides
  return mapPathSegments(identity, (segment) => (isIdLike(segment) ? "{id}" : segment));
}

/** Page identity: scheme (as seen) + lowercased host + port + path (decoded, trailing slash
 *  dropped, NO id collapse — see file header). Query and fragment dropped. */
export function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port && !DEFAULT_PORTS.has(parsed.port) ? `:${parsed.port}` : "";
    const path = mapPathSegments(parsed.pathname, (s) => s);
    return `${parsed.protocol}//${host}${port}${path}`;
  } catch {
    return url; // not absolute/parseable — best-effort passthrough
  }
}

/** True when any path segment is an auth-ish word (login|signin|sign-in|auth|sso|oauth). */
export function isLoginPath(path: string): boolean {
  return splitPathIdentity(path)
    .split("/")
    .some((segment) => LOGIN_SEGMENT.test(segment));
}

/** The collapsed param segment ("{id}") of a normalized path, or undefined. */
export function pathParamName(path: string): string | undefined {
  return splitPathIdentity(path)
    .split("/")
    .find((segment) => /^\{[^}]+\}$/.test(segment));
}
