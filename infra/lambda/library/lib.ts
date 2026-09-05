import { ADMIN_GROUP } from "./constants";

export const NAME_MAX = 40;

// A control character disqualifies a name: C0 controls (codes 0-31) and DEL (127).
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

// Trimmed, 1-NAME_MAX chars, no control characters. nameLower is the
// case-insensitive identity used for duplicate checks.
export function normalizeName(raw: unknown): { name: string; nameLower: string } | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX) return undefined;
  if (hasControlChar(name)) return undefined;
  return { name, nameLower: name.toLowerCase() };
}

// The HTTP API JWT authorizer hands Cognito's array claim to the Lambda as a
// string like "[admins]" (or "[a b]" / "[a, b]" for several groups); tests and
// other authorizers pass a real array. Accept both.
export function isAdmin(claims: Record<string, unknown>): boolean {
  const raw = claims["cognito:groups"];
  let groups: string[];
  if (Array.isArray(raw)) groups = raw.map(String);
  else if (typeof raw === "string" && raw.startsWith("[") && raw.endsWith("]")) {
    groups = raw.slice(1, -1).split(/[\s,]+/).filter(Boolean);
  } else return false;
  return groups.includes(ADMIN_GROUP);
}

export function parseJsonBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export type Route =
  | { kind: "overlay" }
  | { kind: "setBookCategory"; bookId: string }
  | { kind: "suggest" }
  | { kind: "createCategory" }
  | { kind: "accept"; id: string }
  | { kind: "reject"; id: string };

export const ADMIN_ROUTES: ReadonlySet<Route["kind"]> = new Set(["createCategory", "accept", "reject"]);

const SEGMENT = "([^/]+)";
const ROUTES: Array<[string, RegExp, (m: RegExpMatchArray) => Route]> = [
  ["GET", /^\/api\/library$/, () => ({ kind: "overlay" })],
  ["PUT", new RegExp(`^/api/books/${SEGMENT}/category$`), (m) => ({ kind: "setBookCategory", bookId: decodeURIComponent(m[1]) })],
  ["POST", /^\/api\/suggestions$/, () => ({ kind: "suggest" })],
  ["POST", /^\/api\/categories$/, () => ({ kind: "createCategory" })],
  ["POST", new RegExp(`^/api/suggestions/${SEGMENT}/accept$`), (m) => ({ kind: "accept", id: decodeURIComponent(m[1]) })],
  ["POST", new RegExp(`^/api/suggestions/${SEGMENT}/reject$`), (m) => ({ kind: "reject", id: decodeURIComponent(m[1]) })],
];

export function matchRoute(method: string, path: string): Route | undefined {
  for (const [m, re, build] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    // A malformed percent-encoded segment (e.g. a lone "%") makes decodeURIComponent
    // throw a URIError; treat that as no match (404) rather than a 500.
    try {
      return build(match);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
