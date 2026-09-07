export type Route =
  | { kind: "download" }
  | { kind: "feed" }
  | { kind: "acquire"; bookId: string; format: string };

const SEGMENT = "([^/]+)";
const ROUTES: Array<[string, RegExp, (m: RegExpMatchArray) => Route]> = [
  ["POST", /^\/api\/download$/, () => ({ kind: "download" })],
  // Public, token-gated routes — no JWT authorizer (a reader app cannot obtain a Cognito
  // token). See infra/lib/api.ts and the exemption in infra/test/stack.test.ts.
  ["GET", /^\/api\/opds$/, () => ({ kind: "feed" })],
  ["GET", new RegExp(`^/api/opds/download/${SEGMENT}/${SEGMENT}$`), (m) => ({
    kind: "acquire", bookId: decodeURIComponent(m[1]), format: decodeURIComponent(m[2]).toLowerCase(),
  })],
];

export function matchRoute(method: string, path: string): Route | undefined {
  for (const [m, re, build] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    try {
      return build(match);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
