# User-Editable Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in users move books between categories and suggest new ones, and let members of a Cognito `admins` group accept suggestions or add categories directly — all as a runtime overlay on the static catalog.

**Architecture:** A new DynamoDB `library` table (single-table: `CATEGORY` / `BOOK` / `SUGGESTION` items) is served by one new `library` Lambda on the existing JWT-protected HTTP API. The SPA fetches `GET /api/library` after `catalog.json` and merges it (`applyOverlay`) before facets/search; every mutation re-fetches the overlay. A manual `scripts/pull-edits.py` folds table state back into `metadata/overrides.yaml`, whose new top-level `categories:` list widens the indexer's valid set.

**Tech Stack:** AWS CDK v2 (TypeScript), Lambda Node 22 with `@aws-sdk/lib-dynamodb`, `AwsCustomResource` seeding, React 18 + Vite + vitest + Testing Library, Python 3.11+ indexer (pytest, PyYAML, boto3).

**Spec:** `docs/superpowers/specs/2026-09-04-user-categories-design.md`

## Global Constraints

- Category name: trimmed, 1–40 characters, no control characters; uniqueness is case-insensitive via `nameLower`, checked against categories **and pending suggestions**.
- Admin group name is exactly `admins`; the authority is the ID token's `cognito:groups` claim (array **or** Cognito's bracketed string form `[admins]`). Admin routes return **403** without it.
- HTTP statuses: `GET /api/library` 200; `PUT /api/books/{id}/category` 204 / 400 unknown category; `POST /api/suggestions` 201 `{id}` / 409 duplicate; `POST /api/categories` 201 / 409; accept/reject 204 / 404 unknown / 409 already resolved (accept also 409 when the name is taken meanwhile). Errors are JSON `{error}`; unexpected exceptions → 500 with logged stack.
- Accept is one `TransactWriteItems` (create category with `source: suggestion`, write the `BOOK` item if `bookId`, set `status: accepted` + `resolvedBy/At`).
- Seed categories (exact strings): `Tech & Programming`, `Security & Hacking`, `Fiction`, `Comics`, `TTRPG`, `Certification`, `Other/Lifestyle`; seeded with conditional `PutItem` (`attribute_not_exists(pk)`), idempotent, never deleting.
- The `library` table is `PAY_PER_REQUEST`, `RemovalPolicy.RETAIN`, keys `pk`/`sk` (strings). The Lambda's IAM grant is read/write on this table only.
- The SPA must still render (read-only, editing controls hidden, one toast) when `GET /api/library` fails.
- All test suites stay offline (no AWS, no network). Existing suites: `cd infra && npm test && npm run typecheck && npx cdk synth`; `cd web && npm test && npm run typecheck && npm run build`; `cd indexer && .venv/bin/pytest -q`.
- Never commit real identifiers: `infra/config.local.json`, `config.yaml`, `infra/outputs.json`, `web/.env*.local` are gitignored and stay that way.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## File map

| File | Responsibility |
|---|---|
| `infra/lambda/library/constants.ts` | `ADMIN_GROUP`, `SEED_CATEGORIES`, `SEED_AT` — shared by CDK and the Lambda (pure TS, no CDK imports). |
| `infra/lib/library.ts` | `Library` construct: table, seed custom resources, Lambda, six routes. |
| `infra/lib/auth.ts` | + `admins` user pool group. |
| `infra/lib/ebook-share-stack.ts` | + `Library` construct and `LibraryTable` output. |
| `infra/lambda/library/lib.ts` | Pure helpers: `normalizeName`, `isAdmin`, `parseJsonBody`, `matchRoute`. |
| `infra/lambda/library/index.ts` | `Store` interface, record types, `handle(event, deps)`, production `handler`. |
| `infra/lambda/library/store.ts` | `DynamoStore implements Store` on `DynamoDBDocumentClient`. |
| `web/src/catalog/library.ts` | Overlay types, `fetchOverlay`, `applyOverlay`, mutation calls. |
| `web/src/auth/AuthProvider.tsx` | + `isAdmin` in `AuthState`. |
| `web/src/components/SuggestForm.tsx` | One-field inline form (name, Submit, Cancel). |
| `web/src/components/BookDetail.tsx` | Category `<select>` + "Suggest a new category…". |
| `web/src/components/CategorySuggestions.tsx` | Facet footer: suggest link, pending chips, admin accept/reject/add. |
| `web/src/components/FacetGroup.tsx` | + optional `footer` prop. |
| `web/src/components/Library.tsx` | Overlay load/merge/refetch, mutation callbacks, `isAdmin` prop, `selectedId`. |
| `indexer/src/ebook_indexer/categorize.py` | `BUILTIN_CATEGORIES`, `valid_categories(overrides)`. |
| `indexer/src/ebook_indexer/config.py` | + `library_table`. |
| `scripts/pull-edits.py` | Fold table state into `overrides.yaml`; report orphans. |
| `scripts/apply-outputs.py` | + `library_table` ← `LibraryTable` (appends the line if missing). |
| `scripts/backup.sh` | + export of the library table. |
| `scripts/make-admin.sh` | Add a user to `admins` by email. |
| `README.md`, `infra/README.md`, `config.example.yaml` | Docs and example config. |

---

### Task 1: Library table, seed, admins group, stack output

**Files:**
- Create: `infra/lambda/library/constants.ts`
- Create: `infra/lib/library.ts`
- Modify: `infra/lib/auth.ts` (after `this.userPool = new cognito.UserPool(...)`)
- Modify: `infra/lib/ebook-share-stack.ts`
- Test: `infra/test/library.test.ts`, `infra/test/auth.test.ts`

**Interfaces:**
- Produces: `ADMIN_GROUP = "admins"`, `SEED_CATEGORIES: readonly string[]`, `SEED_AT` (constants.ts); `class Library extends Construct` with `readonly table: dynamodb.Table` and `constructor(scope, id, props: { httpApi: apigw.HttpApi })`; stack output `LibraryTable`.

- [ ] **Step 1: Write the constants file**

```ts
// infra/lambda/library/constants.ts
// Shared by the CDK stack (seeding, Cognito group) and the library Lambda.
// Keep this file free of CDK imports: it is bundled into the Lambda.
export const ADMIN_GROUP = "admins";

export const SEED_CATEGORIES = [
  "Tech & Programming", "Security & Hacking", "Fiction", "Comics", "TTRPG", "Certification", "Other/Lifestyle",
] as const;

// Fixed so the seed custom resources' parameters never change between deploys.
export const SEED_AT = "2026-09-04T00:00:00.000Z";
```

- [ ] **Step 2: Write the failing tests**

```ts
// infra/test/library.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { describe, expect, it } from "vitest";
import { SEED_CATEGORIES } from "../lambda/library/constants";
import { Library } from "../lib/library";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const httpApi = new apigw.HttpApi(stack, "HttpApi");
  const library = new Library(stack, "Library", { httpApi });
  return { t: Template.fromStack(stack), library };
}

describe("Library", () => {
  it("creates a retained on-demand table keyed by pk/sk", () => {
    const { t } = synth();
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      }),
    });
  });

  it("seeds every built-in category with a conditional, idempotent PutItem", () => {
    const { t } = synth();
    t.resourceCountIs("Custom::AWS", SEED_CATEGORIES.length);
    // The SDK call is serialised as a JSON string joined with the table-name token
    // (Fn::Join), so assert on the rendered template text rather than the property shape.
    const rendered = JSON.stringify(t.toJSON());
    expect(rendered.split("attribute_not_exists(pk)").length - 1).toBe(SEED_CATEGORIES.length * 2); // Create + Update
    expect(rendered.split("ConditionalCheckFailedException").length - 1).toBe(SEED_CATEGORIES.length * 2);
    for (const name of SEED_CATEGORIES) expect(rendered).toContain(name);
    expect(SEED_CATEGORIES).toContain("Other/Lifestyle");
  });
});
```

Add to `infra/test/auth.test.ts` inside `describe("Auth")`:

```ts
  it("creates the admins group on the pool", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "admins" });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library.test.ts test/auth.test.ts`
Expected: FAIL — `Cannot find module '../lib/library'`; auth test fails with no `AWS::Cognito::UserPoolGroup`.

- [ ] **Step 4: Write the construct and the group**

```ts
// infra/lib/library.ts
import { RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { SEED_AT, SEED_CATEGORIES } from "../lambda/library/constants";

export interface LibraryProps {
  httpApi: apigw.HttpApi;
}

// Runtime-mutable overlay on the static catalog: categories, per-book category
// changes, and category suggestions. See docs/superpowers/specs/2026-09-04-user-categories-design.md.
export class Library extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LibraryProps) {
    super(scope, id);
    void props; // routes are added in a later task

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Seed the built-in categories so catalog.json values and the table agree from
    // the first deploy. Conditional puts make redeploys no-ops and never delete.
    SEED_CATEGORIES.forEach((name, i) => {
      const call: cr.AwsSdkCall = {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: this.table.tableName,
          Item: {
            pk: { S: "CATEGORY" }, sk: { S: name }, nameLower: { S: name.toLowerCase() },
            createdBy: { S: "seed" }, createdAt: { S: SEED_AT }, source: { S: "seed" },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        physicalResourceId: cr.PhysicalResourceId.of(`seed-category-${i}`),
        ignoreErrorCodesMatching: "ConditionalCheckFailedException",
      };
      new cr.AwsCustomResource(this, `Seed${i}`, {
        onCreate: call,
        onUpdate: call,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.table.tableArn] }),
        installLatestAwsSdk: false,
        logRetention: logs.RetentionDays.ONE_MONTH,
      });
    });
  }
}
```

In `infra/lib/auth.ts`, add the import and the group right after the `this.userPool = new cognito.UserPool(...)` statement:

```ts
import { ADMIN_GROUP } from "../lambda/library/constants";
```

```ts
    // Members may accept category suggestions and add categories directly
    // (see infra/lib/library.ts). Add people with scripts/make-admin.sh.
    new cognito.CfnUserPoolGroup(this, "Admins", {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: "May accept category suggestions and add categories",
    });
```

In `infra/lib/ebook-share-stack.ts`, import `Library` and wire it after `api`:

```ts
import { Library } from "./library";
```

```ts
    const library = new Library(this, "Library", { httpApi: api.httpApi });
```

and add the output next to `DownloadsTable`:

```ts
    new CfnOutput(this, "LibraryTable", { value: library.table.tableName });
```

- [ ] **Step 5: Run tests, typecheck, synth**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null`
Expected: all suites PASS (the new library tests and auth test included); synth succeeds. `cdk synth` needs `infra/config.local.json` — it exists on this machine.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/library/constants.ts infra/lib/library.ts infra/lib/auth.ts infra/lib/ebook-share-stack.ts infra/test/library.test.ts infra/test/auth.test.ts
git commit -m "feat(infra): library table with seeded categories and admins group"
```

---

### Task 2: Library Lambda pure helpers

**Files:**
- Create: `infra/lambda/library/lib.ts`
- Test: `infra/test/library-lib.test.ts`

**Interfaces:**
- Consumes: `ADMIN_GROUP` from `./constants`.
- Produces:
  - `NAME_MAX = 40`
  - `normalizeName(raw: unknown): { name: string; nameLower: string } | undefined`
  - `isAdmin(claims: Record<string, unknown>): boolean`
  - `parseJsonBody(body: string | undefined): Record<string, unknown> | undefined`
  - `type Route = { kind: "overlay" } | { kind: "setBookCategory"; bookId: string } | { kind: "suggest" } | { kind: "createCategory" } | { kind: "accept"; id: string } | { kind: "reject"; id: string }`
  - `matchRoute(method: string, path: string): Route | undefined`
  - `ADMIN_ROUTES: ReadonlySet<Route["kind"]>` = `createCategory`, `accept`, `reject`

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/library-lib.test.ts
import { describe, expect, it } from "vitest";
import { ADMIN_ROUTES, isAdmin, matchRoute, NAME_MAX, normalizeName, parseJsonBody } from "../lambda/library/lib";

describe("normalizeName", () => {
  it("trims and lowercases for comparison", () => {
    expect(normalizeName("  Cookbooks ")).toEqual({ name: "Cookbooks", nameLower: "cookbooks" });
  });
  it("rejects empty, non-string, too long, and control characters", () => {
    expect(normalizeName("")).toBeUndefined();
    expect(normalizeName("   ")).toBeUndefined();
    expect(normalizeName(42)).toBeUndefined();
    expect(normalizeName("x".repeat(NAME_MAX + 1))).toBeUndefined();
    expect(normalizeName("x".repeat(NAME_MAX))).toBeDefined();
    expect(normalizeName("bad name")).toBeUndefined();
    expect(normalizeName("bad\nname")).toBeUndefined();
  });
});

describe("isAdmin", () => {
  it("accepts the array and the bracketed-string claim forms", () => {
    expect(isAdmin({ "cognito:groups": ["admins"] })).toBe(true);
    expect(isAdmin({ "cognito:groups": ["readers", "admins"] })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[admins]" })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[readers admins]" })).toBe(true);
    expect(isAdmin({ "cognito:groups": "[readers, admins]" })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isAdmin({})).toBe(false);
    expect(isAdmin({ "cognito:groups": ["readers"] })).toBe(false);
    expect(isAdmin({ "cognito:groups": "[administrators]" })).toBe(false);
    expect(isAdmin({ "cognito:groups": "admins-not-really" })).toBe(false);
  });
});

describe("parseJsonBody", () => {
  it("returns an object for a JSON object body, otherwise undefined", () => {
    expect(parseJsonBody('{"name":"x"}')).toEqual({ name: "x" });
    expect(parseJsonBody(undefined)).toBeUndefined();
    expect(parseJsonBody("nope")).toBeUndefined();
    expect(parseJsonBody("[1]")).toBeUndefined();
    expect(parseJsonBody("null")).toBeUndefined();
  });
});

describe("matchRoute", () => {
  it("matches the six routes", () => {
    expect(matchRoute("GET", "/api/library")).toEqual({ kind: "overlay" });
    expect(matchRoute("PUT", "/api/books/abc123/category")).toEqual({ kind: "setBookCategory", bookId: "abc123" });
    expect(matchRoute("POST", "/api/suggestions")).toEqual({ kind: "suggest" });
    expect(matchRoute("POST", "/api/categories")).toEqual({ kind: "createCategory" });
    expect(matchRoute("POST", "/api/suggestions/s1/accept")).toEqual({ kind: "accept", id: "s1" });
    expect(matchRoute("POST", "/api/suggestions/s1/reject")).toEqual({ kind: "reject", id: "s1" });
  });
  it("rejects other methods and paths and decodes path segments", () => {
    expect(matchRoute("POST", "/api/library")).toBeUndefined();
    expect(matchRoute("GET", "/api/books/abc/category")).toBeUndefined();
    expect(matchRoute("PUT", "/api/books//category")).toBeUndefined();
    expect(matchRoute("POST", "/api/suggestions/s1/approve")).toBeUndefined();
    expect(matchRoute("PUT", "/api/books/a%20b/category")).toEqual({ kind: "setBookCategory", bookId: "a b" });
  });
  it("names the admin-only routes", () => {
    expect([...ADMIN_ROUTES].sort()).toEqual(["accept", "createCategory", "reject"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library-lib.test.ts`
Expected: FAIL — `Cannot find module '../lambda/library/lib'`.

- [ ] **Step 3: Write the helpers**

```ts
// infra/lambda/library/lib.ts
import { ADMIN_GROUP } from "./constants";

export const NAME_MAX = 40;

// Trimmed, 1–NAME_MAX chars, no control characters. nameLower is the
// case-insensitive identity used for duplicate checks.
export function normalizeName(raw: unknown): { name: string; nameLower: string } | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined;
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
    if (match) return build(match);
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/library-lib.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/library/lib.ts infra/test/library-lib.test.ts
git commit -m "feat(library): name validation, admin claim parsing, and route matching"
```

---

### Task 3: Library Lambda handler against a `Store` interface

**Files:**
- Create: `infra/lambda/library/index.ts`
- Test: `infra/test/library-handler.test.ts`

**Interfaces:**
- Consumes: `normalizeName`, `isAdmin`, `parseJsonBody`, `matchRoute`, `ADMIN_ROUTES` from `./lib`.
- Produces (all exported from `index.ts`):

```ts
export interface Category { name: string; nameLower: string; createdBy: string; createdAt: string; source: "seed" | "admin" | "suggestion" }
export interface BookCategory { bookId: string; category: string; changedBy: string; changedAt: string }
export interface Suggestion {
  id: string; name: string; nameLower: string; bookId?: string; suggestedBy: string; createdAt: string;
  status: "pending" | "accepted" | "rejected"; resolvedBy?: string; resolvedAt?: string;
}
export interface Store {
  listCategories(): Promise<Category[]>;
  listBookCategories(): Promise<BookCategory[]>;
  listPendingSuggestions(): Promise<Suggestion[]>;
  getSuggestion(id: string): Promise<Suggestion | undefined>;
  putCategory(c: Category): Promise<boolean>;          // false when the name already exists
  putBookCategory(b: BookCategory): Promise<void>;
  putSuggestion(s: Suggestion): Promise<void>;
  acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string): Promise<boolean>; // false when the transaction's conditions fail
  rejectSuggestion(id: string, resolvedBy: string, resolvedAt: string): Promise<boolean>; // false when not pending
}
export interface Deps { store: Store; now: () => Date; newId: () => string }
export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2>
```

  The production `handler` export is wired in Task 4 (it needs `DynamoStore`); this task exports `handle` only and a placeholder-free `index.ts` compiles on its own.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/library-handler.test.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Category, Deps, Store, Suggestion } from "../lambda/library/index";
import { handle } from "../lambda/library/index";

const NOW = "2026-09-04T12:00:00.000Z";
const fiction: Category = { name: "Fiction", nameLower: "fiction", createdBy: "seed", createdAt: NOW, source: "seed" };
const pending: Suggestion = { id: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" };

function store(over: Partial<Store> = {}): Store {
  return {
    listCategories: vi.fn().mockResolvedValue([fiction]),
    listBookCategories: vi.fn().mockResolvedValue([{ bookId: "b9", category: "Fiction", changedBy: "u@x", changedAt: NOW }]),
    listPendingSuggestions: vi.fn().mockResolvedValue([pending]),
    getSuggestion: vi.fn().mockResolvedValue(pending),
    putCategory: vi.fn().mockResolvedValue(true),
    putBookCategory: vi.fn().mockResolvedValue(undefined),
    putSuggestion: vi.fn().mockResolvedValue(undefined),
    acceptSuggestion: vi.fn().mockResolvedValue(true),
    rejectSuggestion: vi.fn().mockResolvedValue(true),
    ...over,
  };
}
function deps(s: Store = store()): Deps {
  return { store: s, now: () => new Date(NOW), newId: () => "id-1" };
}
function event(method: string, path: string, body?: unknown, claims: Record<string, unknown> = { email: "u@x" }) {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const admin = { email: "a@x", "cognito:groups": "[admins]" };
function parse(res: Awaited<ReturnType<typeof handle>>) {
  const r = res as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}

describe("GET /api/library", () => {
  it("returns sorted categories, the book map, and pending suggestions", async () => {
    const s = store({ listCategories: vi.fn().mockResolvedValue([fiction, { ...fiction, name: "Comics", nameLower: "comics" }]) });
    const { status, json } = parse(await handle(event("GET", "/api/library"), deps(s)));
    expect(status).toBe(200);
    expect(json).toEqual({
      categories: [{ name: "Comics", source: "seed" }, { name: "Fiction", source: "seed" }],
      bookCategories: { b9: "Fiction" },
      suggestions: [{ id: "s1", name: "Cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW }],
    });
  });
  it("404s unknown routes and 401s tokens without an email", async () => {
    expect(parse(await handle(event("GET", "/api/nope"), deps())).status).toBe(404);
    expect(parse(await handle(event("GET", "/api/library", undefined, {}), deps())).status).toBe(401);
  });
});

describe("PUT /api/books/{id}/category", () => {
  it("writes the BOOK item for an existing category", async () => {
    const s = store();
    const { status } = parse(await handle(event("PUT", "/api/books/b1/category", { category: "Fiction" }), deps(s)));
    expect(status).toBe(204);
    expect(s.putBookCategory).toHaveBeenCalledWith({ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
  });
  it("400s an unknown or malformed category", async () => {
    expect(parse(await handle(event("PUT", "/api/books/b1/category", { category: "Nope" }), deps())).status).toBe(400);
    expect(parse(await handle(event("PUT", "/api/books/b1/category", { category: "" }), deps())).status).toBe(400);
    expect(parse(await handle(event("PUT", "/api/books/b1/category"), deps())).status).toBe(400);
  });
});

describe("POST /api/suggestions", () => {
  it("stores a pending suggestion with the optional book", async () => {
    const s = store();
    const { status, json } = parse(await handle(event("POST", "/api/suggestions", { name: " Cookery ", bookId: "b1" }), deps(s)));
    expect(status).toBe(201);
    expect(json).toEqual({ id: "id-1" });
    expect(s.putSuggestion).toHaveBeenCalledWith({
      id: "id-1", name: "Cookery", nameLower: "cookery", bookId: "b1", suggestedBy: "u@x", createdAt: NOW, status: "pending",
    });
  });
  it("omits bookId when absent and 400s a non-string bookId", async () => {
    const s = store();
    parse(await handle(event("POST", "/api/suggestions", { name: "Cookery" }), deps(s)));
    expect((s.putSuggestion as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty("bookId");
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "Cookery", bookId: 5 }), deps())).status).toBe(400);
  });
  it("409s a name that matches a category or a pending suggestion, case-insensitively", async () => {
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "fiction" }), deps())).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions", { name: "COOKBOOKS" }), deps())).status).toBe(409);
  });
});

describe("admin routes", () => {
  it("403 without the admins group", async () => {
    expect(parse(await handle(event("POST", "/api/categories", { name: "X" }), deps())).status).toBe(403);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined), deps())).status).toBe(403);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined), deps())).status).toBe(403);
  });
  it("creates a category directly", async () => {
    const s = store();
    const { status, json } = parse(await handle(event("POST", "/api/categories", { name: "Cookery" }, admin), deps(s)));
    expect(status).toBe(201);
    expect(json).toEqual({ name: "Cookery" });
    expect(s.putCategory).toHaveBeenCalledWith({ name: "Cookery", nameLower: "cookery", createdBy: "a@x", createdAt: NOW, source: "admin" });
  });
  it("409s duplicates on create, including when the conditional put loses a race", async () => {
    expect(parse(await handle(event("POST", "/api/categories", { name: "Fiction" }, admin), deps())).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/categories", { name: "Cookbooks" }, admin), deps())).status).toBe(409); // pending suggestion
    const s = store({ putCategory: vi.fn().mockResolvedValue(false) });
    expect(parse(await handle(event("POST", "/api/categories", { name: "Fresh" }, admin), deps(s))).status).toBe(409);
  });
  it("accepts a suggestion in one transaction that creates the category and moves the book", async () => {
    const s = store();
    const { status } = parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), deps(s)));
    expect(status).toBe(204);
    expect(s.acceptSuggestion).toHaveBeenCalledWith(
      "s1",
      { name: "Cookbooks", nameLower: "cookbooks", createdBy: "a@x", createdAt: NOW, source: "suggestion" },
      { bookId: "b1", category: "Cookbooks", changedBy: "a@x", changedAt: NOW },
      "a@x", NOW,
    );
  });
  it("accept: passes no book when the suggestion has none; 404 unknown; 409 resolved, taken, or lost transaction", async () => {
    const noBook = store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, bookId: undefined }) });
    await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin), deps(noBook));
    expect((noBook.acceptSuggestion as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBeUndefined();

    expect(parse(await handle(event("POST", "/api/suggestions/zz/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue(undefined) })))).status).toBe(404);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, status: "rejected" }) })))).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue({ ...pending, name: "Fiction", nameLower: "fiction" }) })))).status).toBe(409);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/accept", undefined, admin),
      deps(store({ acceptSuggestion: vi.fn().mockResolvedValue(false) })))).status).toBe(409);
  });
  it("rejects a pending suggestion; 404 unknown; 409 already resolved", async () => {
    const s = store();
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin), deps(s))).status).toBe(204);
    expect(s.rejectSuggestion).toHaveBeenCalledWith("s1", "a@x", NOW);
    expect(parse(await handle(event("POST", "/api/suggestions/zz/reject", undefined, admin),
      deps(store({ getSuggestion: vi.fn().mockResolvedValue(undefined) })))).status).toBe(404);
    expect(parse(await handle(event("POST", "/api/suggestions/s1/reject", undefined, admin),
      deps(store({ rejectSuggestion: vi.fn().mockResolvedValue(false) })))).status).toBe(409);
  });
});

describe("failures", () => {
  it("500s with a JSON error when the store throws", async () => {
    const s = store({ listCategories: vi.fn().mockRejectedValue(new Error("boom")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, json } = parse(await handle(event("GET", "/api/library"), deps(s)));
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Internal error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library-handler.test.ts`
Expected: FAIL — `Cannot find module '../lambda/library/index'`.

- [ ] **Step 3: Write the handler**

```ts
// infra/lambda/library/index.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ADMIN_ROUTES, isAdmin, matchRoute, normalizeName, parseJsonBody, type Route } from "./lib";

export interface Category { name: string; nameLower: string; createdBy: string; createdAt: string; source: "seed" | "admin" | "suggestion" }
export interface BookCategory { bookId: string; category: string; changedBy: string; changedAt: string }
export interface Suggestion {
  id: string; name: string; nameLower: string; bookId?: string; suggestedBy: string; createdAt: string;
  status: "pending" | "accepted" | "rejected"; resolvedBy?: string; resolvedAt?: string;
}

export interface Store {
  listCategories(): Promise<Category[]>;
  listBookCategories(): Promise<BookCategory[]>;
  listPendingSuggestions(): Promise<Suggestion[]>;
  getSuggestion(id: string): Promise<Suggestion | undefined>;
  /** false when a category with this name already exists (conditional put). */
  putCategory(c: Category): Promise<boolean>;
  putBookCategory(b: BookCategory): Promise<void>;
  putSuggestion(s: Suggestion): Promise<void>;
  /** One transaction: create category, move book (if any), mark accepted. false when a condition fails. */
  acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string): Promise<boolean>;
  /** false when the suggestion is no longer pending. */
  rejectSuggestion(id: string, resolvedBy: string, resolvedAt: string): Promise<boolean>;
}

export interface Deps { store: Store; now: () => Date; newId: () => string }

const BOOK_ID_MAX = 64;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204 });

async function nameTaken(store: Store, nameLower: string): Promise<boolean> {
  const [categories, pending] = await Promise.all([store.listCategories(), store.listPendingSuggestions()]);
  return categories.some((c) => c.nameLower === nameLower) || pending.some((s) => s.nameLower === nameLower);
}

async function dispatch(route: Route, event: APIGatewayProxyEventV2WithJWTAuthorizer, email: string, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const { store } = deps;
  const at = deps.now().toISOString();
  switch (route.kind) {
    case "overlay": {
      const [categories, books, pending] = await Promise.all([
        store.listCategories(), store.listBookCategories(), store.listPendingSuggestions(),
      ]);
      return json(200, {
        categories: [...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, source: c.source })),
        bookCategories: Object.fromEntries(books.map((b) => [b.bookId, b.category])),
        suggestions: [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => ({
          id: s.id, name: s.name, ...(s.bookId ? { bookId: s.bookId } : {}), suggestedBy: s.suggestedBy, createdAt: s.createdAt,
        })),
      });
    }
    case "setBookCategory": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.category);
      if (!n) return json(400, { error: "Body must be JSON {category}" });
      const categories = await store.listCategories();
      const match = categories.find((c) => c.name === n.name);
      if (!match) return json(400, { error: "Unknown category" });
      await store.putBookCategory({ bookId: route.bookId, category: match.name, changedBy: email, changedAt: at });
      return noContent();
    }
    case "suggest": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name, bookId?}" });
      const bookId = body?.bookId;
      if (bookId !== undefined && (typeof bookId !== "string" || bookId.length === 0 || bookId.length > BOOK_ID_MAX)) {
        return json(400, { error: "bookId must be a non-empty string" });
      }
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const id = deps.newId();
      await store.putSuggestion({
        id, name: n.name, nameLower: n.nameLower, ...(bookId ? { bookId } : {}), suggestedBy: email, createdAt: at, status: "pending",
      });
      return json(201, { id });
    }
    case "createCategory": {
      const body = parseJsonBody(event.body);
      const n = normalizeName(body?.name);
      if (!n) return json(400, { error: "Body must be JSON {name}" });
      if (await nameTaken(store, n.nameLower)) return json(409, { error: "That category already exists or has been suggested" });
      const created = await store.putCategory({ name: n.name, nameLower: n.nameLower, createdBy: email, createdAt: at, source: "admin" });
      if (!created) return json(409, { error: "That category already exists" });
      return json(201, { name: n.name });
    }
    case "accept": {
      const s = await store.getSuggestion(route.id);
      if (!s) return json(404, { error: "Unknown suggestion" });
      if (s.status !== "pending") return json(409, { error: `Suggestion already ${s.status}` });
      const categories = await store.listCategories();
      if (categories.some((c) => c.nameLower === s.nameLower)) return json(409, { error: "That category already exists" });
      const category: Category = { name: s.name, nameLower: s.nameLower, createdBy: email, createdAt: at, source: "suggestion" };
      const book = s.bookId ? { bookId: s.bookId, category: s.name, changedBy: email, changedAt: at } : undefined;
      const ok = await store.acceptSuggestion(s.id, category, book, email, at);
      if (!ok) return json(409, { error: "Suggestion changed underneath you; reload and try again" });
      return noContent();
    }
    case "reject": {
      const s = await store.getSuggestion(route.id);
      if (!s) return json(404, { error: "Unknown suggestion" });
      const ok = await store.rejectSuggestion(s.id, email, at);
      if (!ok) return json(409, { error: "Suggestion already resolved" });
      return noContent();
    }
  }
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const route = matchRoute(event.requestContext.http.method, event.rawPath);
  if (!route) return json(404, { error: "Not found" });
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = String(claims.email ?? "");
  if (!email) return json(401, { error: "Token has no email claim (send the ID token)" });
  if (ADMIN_ROUTES.has(route.kind) && !isAdmin(claims)) return json(403, { error: "Admin only" });
  try {
    return await dispatch(route, event, email, deps);
  } catch (e) {
    console.error("library handler failed:", e);
    return json(500, { error: "Internal error" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/library-handler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/library/index.ts infra/test/library-handler.test.ts
git commit -m "feat(library): request handler for overlay, category edits, and suggestions"
```

---

### Task 4: DynamoDB store and production wiring

**Files:**
- Create: `infra/lambda/library/store.ts`
- Modify: `infra/lambda/library/index.ts` (append production wiring)
- Test: `infra/test/library-store.test.ts`

**Interfaces:**
- Consumes: `Store`, `Category`, `BookCategory`, `Suggestion` from `./index`.
- Produces: `class DynamoStore implements Store` with `constructor(ddb: DynamoDBDocumentClient, tableName: string)`; `export const handler` in `index.ts` reading `process.env.LIBRARY_TABLE`.

Item layout (all strings): categories `pk=CATEGORY, sk=<name>`; book categories `pk=BOOK, sk=<bookId>`; suggestions `pk=SUGGESTION, sk=<id>`. Other attributes are stored under their interface names (`nameLower`, `createdBy`, `category`, `status`, …).

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/library-store.test.ts
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoStore } from "../lambda/library/store";

const NOW = "2026-09-04T12:00:00.000Z";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}
function conditionalFailure() {
  const e = new Error("cond") as Error & { name: string };
  e.name = "ConditionalCheckFailedException";
  return e;
}
function transactionCancelled() {
  const e = new Error("cancelled") as Error & { name: string };
  e.name = "TransactionCanceledException";
  return e;
}

describe("DynamoStore reads", () => {
  it("lists categories by pk and follows pagination", async () => {
    const pages = [
      { Items: [{ pk: "CATEGORY", sk: "Fiction", nameLower: "fiction", createdBy: "seed", createdAt: NOW, source: "seed" }], LastEvaluatedKey: { pk: "CATEGORY", sk: "Fiction" } },
      { Items: [{ pk: "CATEGORY", sk: "Comics", nameLower: "comics", createdBy: "seed", createdAt: NOW, source: "seed" }] },
    ];
    const { ddb, send } = client(() => pages.shift());
    const out = await new DynamoStore(ddb, "T").listCategories();
    expect(out.map((c) => c.name)).toEqual(["Fiction", "Comics"]);
    const first = send.mock.calls[0][0] as QueryCommand;
    expect(first).toBeInstanceOf(QueryCommand);
    expect(first.input).toMatchObject({ TableName: "T", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "CATEGORY" } });
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: "CATEGORY", sk: "Fiction" });
  });
  it("maps book and suggestion items and filters suggestions to pending", async () => {
    const { ddb } = client((cmd) => {
      const pk = (cmd as QueryCommand).input.ExpressionAttributeValues?.[":pk"];
      if (pk === "BOOK") return { Items: [{ pk, sk: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW }] };
      return { Items: [
        { pk, sk: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" },
        { pk, sk: "s0", name: "Old", nameLower: "old", suggestedBy: "z@x", createdAt: NOW, status: "rejected", resolvedBy: "a@x", resolvedAt: NOW },
      ] };
    });
    const store = new DynamoStore(ddb, "T");
    expect(await store.listBookCategories()).toEqual([{ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW }]);
    const pending = await store.listPendingSuggestions();
    expect(pending).toEqual([{ id: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" }]);
    expect((await store.listPendingSuggestions())[0]).not.toHaveProperty("resolvedBy");
  });
  it("gets one suggestion by id, undefined when missing", async () => {
    const { ddb, send } = client((cmd) => ((cmd as GetCommand).input.Key?.sk === "s1"
      ? { Item: { pk: "SUGGESTION", sk: "s1", name: "X", nameLower: "x", suggestedBy: "z@x", createdAt: NOW, status: "pending" } }
      : {}));
    const store = new DynamoStore(ddb, "T");
    expect((await store.getSuggestion("s1"))?.id).toBe("s1");
    expect(await store.getSuggestion("nope")).toBeUndefined();
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });
});

describe("DynamoStore writes", () => {
  it("putCategory is a conditional put and reports a duplicate as false", async () => {
    const { ddb, send } = client(() => ({}));
    const ok = await new DynamoStore(ddb, "T").putCategory({ name: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" });
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input).toEqual({
      TableName: "T", ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: "CATEGORY", sk: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" },
    });
    const dup = client(() => { throw conditionalFailure(); });
    expect(await new DynamoStore(dup.ddb, "T").putCategory({ name: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" })).toBe(false);
  });
  it("putBookCategory and putSuggestion write the expected items", async () => {
    const { ddb, send } = client(() => ({}));
    const store = new DynamoStore(ddb, "T");
    await store.putBookCategory({ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
    await store.putSuggestion({ id: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" });
    expect((send.mock.calls[0][0] as PutCommand).input.Item).toEqual({ pk: "BOOK", sk: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
    expect((send.mock.calls[1][0] as PutCommand).input.Item).toEqual({ pk: "SUGGESTION", sk: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" });
  });
  it("acceptSuggestion is one transaction: conditional category put, book put, guarded status update", async () => {
    const { ddb, send } = client(() => ({}));
    const ok = await new DynamoStore(ddb, "T").acceptSuggestion(
      "s1",
      { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" },
      { bookId: "b1", category: "C", changedBy: "a@x", changedAt: NOW },
      "a@x", NOW,
    );
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems).toEqual([
      { Put: { TableName: "T", ConditionExpression: "attribute_not_exists(pk)",
        Item: { pk: "CATEGORY", sk: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" } } },
      { Put: { TableName: "T", Item: { pk: "BOOK", sk: "b1", category: "C", changedBy: "a@x", changedAt: NOW } } },
      { Update: { TableName: "T", Key: { pk: "SUGGESTION", sk: "s1" },
        UpdateExpression: "SET #status = :accepted, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":accepted": "accepted", ":pending": "pending", ":by": "a@x", ":at": NOW } } },
    ]);
  });
  it("acceptSuggestion without a book has two items, and a cancelled transaction returns false", async () => {
    const { ddb, send } = client(() => ({}));
    await new DynamoStore(ddb, "T").acceptSuggestion("s1", { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" }, undefined, "a@x", NOW);
    expect((send.mock.calls[0][0] as TransactWriteCommand).input.TransactItems).toHaveLength(2);
    const lost = client(() => { throw transactionCancelled(); });
    expect(await new DynamoStore(lost.ddb, "T").acceptSuggestion("s1", { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" }, undefined, "a@x", NOW)).toBe(false);
  });
  it("rejectSuggestion is a guarded update; false when not pending", async () => {
    const { ddb, send } = client(() => ({}));
    expect(await new DynamoStore(ddb, "T").rejectSuggestion("s1", "a@x", NOW)).toBe(true);
    const cmd = send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input).toEqual({
      TableName: "T", Key: { pk: "SUGGESTION", sk: "s1" },
      UpdateExpression: "SET #status = :rejected, resolvedBy = :by, resolvedAt = :at",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":by": "a@x", ":at": NOW },
    });
    const done = client(() => { throw conditionalFailure(); });
    expect(await new DynamoStore(done.ddb, "T").rejectSuggestion("s1", "a@x", NOW)).toBe(false);
  });
  it("rethrows unexpected errors", async () => {
    const { ddb } = client(() => { throw new Error("network"); });
    await expect(new DynamoStore(ddb, "T").listCategories()).rejects.toThrow("network");
    await expect(new DynamoStore(ddb, "T").rejectSuggestion("s1", "a@x", NOW)).rejects.toThrow("network");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library-store.test.ts`
Expected: FAIL — `Cannot find module '../lambda/library/store'`.

- [ ] **Step 3: Write the store**

```ts
// infra/lambda/library/store.ts
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BookCategory, Category, Store, Suggestion } from "./index";

type Item = Record<string, unknown>;

function isNamed(e: unknown, name: string): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === name;
}

function toCategory(i: Item): Category {
  return { name: String(i.sk), nameLower: String(i.nameLower), createdBy: String(i.createdBy), createdAt: String(i.createdAt), source: i.source as Category["source"] };
}
function toBook(i: Item): BookCategory {
  return { bookId: String(i.sk), category: String(i.category), changedBy: String(i.changedBy), changedAt: String(i.changedAt) };
}
function toSuggestion(i: Item): Suggestion {
  return {
    id: String(i.sk), name: String(i.name), nameLower: String(i.nameLower),
    ...(typeof i.bookId === "string" ? { bookId: i.bookId } : {}),
    suggestedBy: String(i.suggestedBy), createdAt: String(i.createdAt), status: i.status as Suggestion["status"],
    ...(typeof i.resolvedBy === "string" ? { resolvedBy: i.resolvedBy } : {}),
    ...(typeof i.resolvedAt === "string" ? { resolvedAt: i.resolvedAt } : {}),
  };
}

export class DynamoStore implements Store {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  private async queryAll(pk: string): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      items.push(...((out.Items ?? []) as Item[]));
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return items;
  }

  async listCategories() { return (await this.queryAll("CATEGORY")).map(toCategory); }
  async listBookCategories() { return (await this.queryAll("BOOK")).map(toBook); }
  async listPendingSuggestions() {
    return (await this.queryAll("SUGGESTION")).map(toSuggestion).filter((s) => s.status === "pending");
  }

  async getSuggestion(id: string) {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: "SUGGESTION", sk: id } }));
    return out.Item ? toSuggestion(out.Item as Item) : undefined;
  }

  private categoryItem(c: Category): Item {
    return { pk: "CATEGORY", sk: c.name, nameLower: c.nameLower, createdBy: c.createdBy, createdAt: c.createdAt, source: c.source };
  }
  private bookItem(b: BookCategory): Item {
    return { pk: "BOOK", sk: b.bookId, category: b.category, changedBy: b.changedBy, changedAt: b.changedAt };
  }

  async putCategory(c: Category) {
    try {
      await this.ddb.send(new PutCommand({ TableName: this.table, Item: this.categoryItem(c), ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (e) {
      if (isNamed(e, "ConditionalCheckFailedException")) return false;
      throw e;
    }
  }

  async putBookCategory(b: BookCategory) {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: this.bookItem(b) }));
  }

  async putSuggestion(s: Suggestion) {
    const { id, ...rest } = s;
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { pk: "SUGGESTION", sk: id, ...rest } }));
  }

  async acceptSuggestion(id: string, category: Category, book: BookCategory | undefined, resolvedBy: string, resolvedAt: string) {
    const TransactItems = [
      { Put: { TableName: this.table, Item: this.categoryItem(category), ConditionExpression: "attribute_not_exists(pk)" } },
      ...(book ? [{ Put: { TableName: this.table, Item: this.bookItem(book) } }] : []),
      { Update: {
        TableName: this.table, Key: { pk: "SUGGESTION", sk: id },
        UpdateExpression: "SET #status = :accepted, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":accepted": "accepted", ":pending": "pending", ":by": resolvedBy, ":at": resolvedAt },
      } },
    ];
    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (e) {
      if (isNamed(e, "TransactionCanceledException")) return false;
      throw e;
    }
  }

  async rejectSuggestion(id: string, resolvedBy: string, resolvedAt: string) {
    try {
      await this.ddb.send(new UpdateCommand({
        TableName: this.table, Key: { pk: "SUGGESTION", sk: id },
        UpdateExpression: "SET #status = :rejected, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":by": resolvedBy, ":at": resolvedAt },
      }));
      return true;
    } catch (e) {
      if (isNamed(e, "ConditionalCheckFailedException")) return false;
      throw e;
    }
  }
}
```

Append the production wiring to the end of `infra/lambda/library/index.ts`:

```ts
// ---- production wiring (never exercised by tests) ----
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { DynamoStore } from "./store";

let productionDeps: Deps | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  productionDeps ??= {
    store: new DynamoStore(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
      process.env.LIBRARY_TABLE ?? "",
    ),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
  return handle(event, productionDeps);
};
```

(`store.ts` imports types from `./index` and `index.ts` imports `DynamoStore` from `./store`; the cycle is type-only in one direction and value-only in the other, which TypeScript and esbuild handle. Move the imports to the top of `index.ts` if `npm run typecheck` complains about import placement.)

Suggestion ids are `randomUUID()`; the spec's "ulid" wording only implies uniqueness — ordering uses `createdAt`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npm test && npm run typecheck`
Expected: PASS (all suites, including download/session ones untouched).

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/library/store.ts infra/lambda/library/index.ts infra/test/library-store.test.ts
git commit -m "feat(library): DynamoDB store with transactional accept, production handler"
```

---

### Task 5: Wire the Lambda and six routes in CDK

**Files:**
- Modify: `infra/lib/library.ts`
- Test: `infra/test/library.test.ts`

**Interfaces:**
- Consumes: `Library` construct from Task 1; handler entry `infra/lambda/library/index.ts` from Task 4.
- Produces: the deployed routes `GET /api/library`, `PUT /api/books/{id}/category`, `POST /api/suggestions`, `POST /api/categories`, `POST /api/suggestions/{id}/accept`, `POST /api/suggestions/{id}/reject`, all on the API's default JWT authorizer; env `LIBRARY_TABLE`.

- [ ] **Step 1: Add the failing tests**

Append inside `describe("Library")` in `infra/test/library.test.ts`:

```ts
  it("wires one Lambda with read/write on the library table only and the six routes", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: { LIBRARY_TABLE: Match.anyValue() } },
    });
    // Exactly one policy grants dynamodb read/write, and it names the table (plus its index ARN pattern) only.
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]), // arrayWith is order-sensitive; this is grantReadWriteData's order
        Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^LibraryTable"), "Arn"] })]),
      })]) },
    });
    for (const key of [
      "GET /api/library", "PUT /api/books/{id}/category", "POST /api/suggestions", "POST /api/categories",
      "POST /api/suggestions/{id}/accept", "POST /api/suggestions/{id}/reject",
    ]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
    t.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/library.test.ts`
Expected: FAIL — no Lambda with `LIBRARY_TABLE`, no routes.

- [ ] **Step 3: Add the Lambda and routes**

In `infra/lib/library.ts`, extend the imports:

```ts
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "node:path";
```

Replace `void props; // routes are added in a later task` with nothing, and append at the end of the constructor (after the seed loop):

```ts
    const fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/library/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { LIBRARY_TABLE: this.table.tableName },
    });
    this.table.grantReadWriteData(fn);

    // One integration, six routes; the API's default JWT authorizer applies to all of them.
    const integration = new HttpLambdaIntegration("LibraryIntegration", fn);
    const routes: Array<[string, apigw.HttpMethod]> = [
      ["/api/library", apigw.HttpMethod.GET],
      ["/api/books/{id}/category", apigw.HttpMethod.PUT],
      ["/api/suggestions", apigw.HttpMethod.POST],
      ["/api/categories", apigw.HttpMethod.POST],
      ["/api/suggestions/{id}/accept", apigw.HttpMethod.POST],
      ["/api/suggestions/{id}/reject", apigw.HttpMethod.POST],
    ];
    for (const [routePath, method] of routes) {
      props.httpApi.addRoutes({ path: routePath, methods: [method], integration });
    }
```

- [ ] **Step 4: Run tests, typecheck, synth**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null`
Expected: PASS. If the IAM assertion fails only on the `Fn::GetAtt` logical-id regex, print `t.findResources("AWS::IAM::Policy")` once, use the actual prefix (it is `LibraryTable` followed by a hash), and keep the assertion.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/library.ts infra/test/library.test.ts
git commit -m "feat(infra): library Lambda and routes on the HTTP API"
```

---

### Task 6: Web overlay client

**Files:**
- Create: `web/src/catalog/library.ts`
- Test: `web/src/catalog/library.test.ts`

**Interfaces:**
- Consumes: `Book` from `./types`.
- Produces:

```ts
export interface Suggestion { id: string; name: string; bookId?: string; suggestedBy: string; createdAt: string }
export interface Overlay { categories: Array<{ name: string; source: string }>; bookCategories: Record<string, string>; suggestions: Suggestion[] }
export function fetchOverlay(apiUrl: string, idToken: string, fetchFn?: typeof fetch): Promise<Overlay>
export function applyOverlay(books: Book[], overlay: Overlay): Book[]
export function setBookCategory(apiUrl: string, idToken: string, bookId: string, category: string, fetchFn?: typeof fetch): Promise<void>
export function suggestCategory(apiUrl: string, idToken: string, name: string, bookId: string | undefined, fetchFn?: typeof fetch): Promise<void>
export function createCategory(apiUrl: string, idToken: string, name: string, fetchFn?: typeof fetch): Promise<void>
export function resolveSuggestion(apiUrl: string, idToken: string, id: string, action: "accept" | "reject", fetchFn?: typeof fetch): Promise<void>
export function suggesterLabel(email: string): string   // "zbmowrey@gmail.com" → "zbmowrey"
```

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/catalog/library.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  applyOverlay, createCategory, fetchOverlay, resolveSuggestion, setBookCategory, suggestCategory, suggesterLabel, type Overlay,
} from "./library";
import type { Book } from "./types";

const book = (id: string, category: string): Book => ({
  id, title: id, authors: [], description: null, category, subjects: [], publisher: null, bundle: "b", year: null,
  formats: [], coverUrl: null, addedAt: "2026-01-01",
});
const overlay: Overlay = {
  categories: [{ name: "Fiction", source: "seed" }, { name: "Cookbooks", source: "admin" }],
  bookCategories: { a: "Cookbooks" },
  suggestions: [],
};

function fetchWith(status: number, body?: unknown, contentType = "application/json") {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    json: async () => body,
  })) as unknown as typeof fetch;
}
function call(f: typeof fetch, n = 0) {
  const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[n];
  return { url: String(m[0]), init: m[1] as RequestInit };
}

describe("fetchOverlay", () => {
  it("GETs /library with the bearer token and validates the shape", async () => {
    const f = fetchWith(200, overlay);
    expect(await fetchOverlay("/api", "tok", f)).toEqual(overlay);
    const { url, init } = call(f);
    expect(url).toBe("/api/library");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
  it("throws on non-200, non-JSON, and malformed bodies", async () => {
    await expect(fetchOverlay("/api", "tok", fetchWith(500, { error: "x" }))).rejects.toThrow("x");
    await expect(fetchOverlay("/api", "tok", fetchWith(200, "<html>", "text/html"))).rejects.toThrow(/non-JSON/);
    await expect(fetchOverlay("/api", "tok", fetchWith(200, { categories: "nope" }))).rejects.toThrow(/malformed/);
  });
});

describe("applyOverlay", () => {
  it("replaces categories from the map, keeps others, and preserves identity of untouched books", () => {
    const a = book("a", "Fiction"), b = book("b", "Fiction");
    const out = applyOverlay([a, b], overlay);
    expect(out.map((x) => x.category)).toEqual(["Cookbooks", "Fiction"]);
    expect(out[1]).toBe(b);
    expect(a.category).toBe("Fiction"); // input not mutated
  });
});

describe("mutations", () => {
  it("setBookCategory PUTs and requires 204", async () => {
    const f = fetchWith(204);
    await setBookCategory("/api", "tok", "a b", "Fiction", f);
    const { url, init } = call(f);
    expect(url).toBe("/api/books/a%20b/category");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ category: "Fiction" }));
    await expect(setBookCategory("/api", "tok", "a", "Nope", fetchWith(400, { error: "Unknown category" }))).rejects.toThrow("Unknown category");
    await expect(setBookCategory("/api", "tok", "a", "X", fetchWith(200, undefined, ""))).rejects.toThrow(/204/);
  });
  it("suggestCategory POSTs name and optional bookId and requires 201", async () => {
    const f = fetchWith(201, { id: "s1" });
    await suggestCategory("/api", "tok", "Cookbooks", "a", f);
    expect(call(f).init.body).toBe(JSON.stringify({ name: "Cookbooks", bookId: "a" }));
    const g = fetchWith(201, { id: "s2" });
    await suggestCategory("/api", "tok", "Cookbooks", undefined, g);
    expect(call(g).init.body).toBe(JSON.stringify({ name: "Cookbooks" }));
    await expect(suggestCategory("/api", "tok", "Fiction", undefined, fetchWith(409, { error: "exists" }))).rejects.toThrow("exists");
  });
  it("createCategory and resolveSuggestion hit the admin routes", async () => {
    const f = fetchWith(201, { name: "X" });
    await createCategory("/api", "tok", "X", f);
    expect(call(f).url).toBe("/api/categories");
    const g = fetchWith(204);
    await resolveSuggestion("/api", "tok", "s1", "accept", g);
    expect(call(g).url).toBe("/api/suggestions/s1/accept");
    expect(call(g).init.method).toBe("POST");
    await expect(resolveSuggestion("/api", "tok", "s1", "reject", fetchWith(403, { error: "Admin only" }))).rejects.toThrow("Admin only");
  });
});

describe("suggesterLabel", () => {
  it("shows the local part only", () => {
    expect(suggesterLabel("zbmowrey@gmail.com")).toBe("zbmowrey");
    expect(suggesterLabel("weird")).toBe("weird");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/catalog/library.test.ts`
Expected: FAIL — cannot resolve `./library`.

- [ ] **Step 3: Write the client**

```ts
// web/src/catalog/library.ts
import type { Book } from "./types";

export interface Suggestion { id: string; name: string; bookId?: string; suggestedBy: string; createdAt: string }
export interface Overlay {
  categories: Array<{ name: string; source: string }>;
  bookCategories: Record<string, string>;
  suggestions: Suggestion[];
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body — keep the fallback
  }
  return fallback;
}

// Same-origin call to the library API. The SPA fallback answers unknown paths with
// 200 HTML, so callers state the exact status they expect.
async function apiCall(
  apiUrl: string, idToken: string, path: string, init: RequestInit, expectStatus: number, fetchFn: typeof fetch,
): Promise<Response> {
  const res = await fetchFn(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status !== expectStatus) throw new Error(await errorMessage(res, `Request failed: expected ${expectStatus}, got ${res.status}`));
  return res;
}

export async function fetchOverlay(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<Overlay> {
  const res = await apiCall(apiUrl, idToken, "/library", { method: "GET" }, 200, fetchFn);
  if (!(res.headers?.get?.("content-type") ?? "").includes("application/json")) throw new Error("Library request returned non-JSON");
  const body = (await res.json()) as Partial<Overlay>;
  if (!Array.isArray(body?.categories) || typeof body.bookCategories !== "object" || body.bookCategories === null || !Array.isArray(body.suggestions)) {
    throw new Error("Library overlay is malformed");
  }
  return body as Overlay;
}

export function applyOverlay(books: Book[], overlay: Overlay): Book[] {
  return books.map((b) => {
    const category = overlay.bookCategories[b.id];
    return category && category !== b.category ? { ...b, category } : b;
  });
}

export async function setBookCategory(apiUrl: string, idToken: string, bookId: string, category: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, `/books/${encodeURIComponent(bookId)}/category`,
    { method: "PUT", body: JSON.stringify({ category }) }, 204, fetchFn);
}

export async function suggestCategory(apiUrl: string, idToken: string, name: string, bookId: string | undefined, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/suggestions",
    { method: "POST", body: JSON.stringify(bookId ? { name, bookId } : { name }) }, 201, fetchFn);
}

export async function createCategory(apiUrl: string, idToken: string, name: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/categories", { method: "POST", body: JSON.stringify({ name }) }, 201, fetchFn);
}

export async function resolveSuggestion(apiUrl: string, idToken: string, id: string, action: "accept" | "reject", fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, `/suggestions/${encodeURIComponent(id)}/${action}`, { method: "POST" }, 204, fetchFn);
}

export function suggesterLabel(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/catalog/library.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/catalog/library.ts web/src/catalog/library.test.ts
git commit -m "feat(web): library overlay client and merge"
```

---

### Task 7: `isAdmin` in AuthProvider and App

**Files:**
- Modify: `web/src/auth/AuthProvider.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/auth/AuthProvider.test.tsx`

**Interfaces:**
- Produces: `AuthState.isAdmin: boolean` (true when the stored ID token's `cognito:groups` array contains `"admins"`); `<Library isAdmin={auth.isAdmin} …/>` — Library's prop is added in Task 10; until then App passes it and TypeScript will complain, so **this task also adds the prop to Library's `Props` as `isAdmin?: boolean` (unused for now)**.

- [ ] **Step 1: Write the failing test**

`web/src/auth/AuthProvider.test.tsx` already has `cfg`, a `jwt(payload)` helper, a `Probe` component, and imports `saveTokens` from `./storage`. Add an `isAdmin` span to `Probe` (next to the `email` span):

```tsx
      <span data-testid="admin">{String(a.isAdmin)}</span>
```

and add these tests inside `describe("AuthProvider")`:

```tsx
  it("exposes isAdmin from the cognito:groups claim", async () => {
    saveTokens({ idToken: jwt({ email: "a@example.com", "cognito:groups": ["admins"] }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    render(<AuthProvider config={cfg} fetchFn={vi.fn() as unknown as typeof fetch}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("admin")).toHaveTextContent("true");
  });
  it("isAdmin is false without the group and after sign-out", async () => {
    saveTokens({ idToken: jwt({ email: "u@example.com", "cognito:groups": ["readers"] }), accessToken: "a", expiresAt: Date.now() + 100_000 });
    render(<AuthProvider config={cfg} fetchFn={vi.fn() as unknown as typeof fetch} navigate={() => {}}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn"));
    expect(screen.getByTestId("admin")).toHaveTextContent("false");
  });
```

(If `saveTokens`'s `Tokens` type has other required fields — check `web/src/auth/tokens.ts` — copy how the file's existing tests call it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/auth/AuthProvider.test.tsx`
Expected: FAIL — renders `signedIn:undefined`.

- [ ] **Step 3: Implement**

In `web/src/auth/AuthProvider.tsx`:

```ts
import { ADMIN_GROUP } from "./groups";
```

Create `web/src/auth/groups.ts`:

```ts
import { decodeJwtPayload } from "./tokens";

export const ADMIN_GROUP = "admins";

export function isAdminToken(idToken: string): boolean {
  const groups = decodeJwtPayload(idToken)["cognito:groups"];
  return Array.isArray(groups) && groups.map(String).includes(ADMIN_GROUP);
}
```

(Then import `isAdminToken` instead of `ADMIN_GROUP` in AuthProvider.) Add `isAdmin: boolean;` to `AuthState` after `email?: string;`. Add state `const [isAdmin, setIsAdmin] = useState(false);`. In `adopt`: `setIsAdmin(isAdminToken(t.idToken));`. In `drop`: `setIsAdmin(false);`. Add `isAdmin` to the `useMemo` value object and its dependency array.

In `web/src/App.tsx` change the Library line to:

```tsx
      <Library apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn} isAdmin={auth.isAdmin} />
```

In `web/src/components/Library.tsx` add `isAdmin?: boolean;` to `Props` and destructure it (`isAdmin = false`) — it is consumed in Task 10.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/auth/groups.ts web/src/auth/AuthProvider.tsx web/src/auth/AuthProvider.test.tsx web/src/App.tsx web/src/components/Library.tsx
git commit -m "feat(web): expose isAdmin from the ID token's cognito:groups claim"
```

---

### Task 8: `SuggestForm` and the category select in `BookDetail`

**Files:**
- Create: `web/src/components/SuggestForm.tsx`
- Modify: `web/src/components/BookDetail.tsx`
- Modify: `web/src/styles.css` (append)
- Test: `web/src/components/SuggestForm.test.tsx`, `web/src/components/BookDetail.test.tsx`

**Interfaces:**
- Produces:
  - `SuggestForm` props `{ label: string; onSubmit: (name: string) => Promise<void>; onCancel: () => void }` — input `aria-label={label}`, `maxLength={40}`, Submit disabled while empty/busy; on submit awaits `onSubmit(trimmed)` then calls `onCancel()` (the parent decides what to show next); if `onSubmit` throws the form stays open and re-enables.
  - `BookDetail` new props: `categories: string[]` (empty ⇒ read-only, plain text as today), `onChangeCategory: (book: Book, category: string) => Promise<void>`, `onSuggest: (name: string, bookId: string) => Promise<void>`. The select has `aria-label="Category"`; its last option's value is `"__suggest__"` with text `Suggest a new category…`.
- Consumes: `Book` from `../catalog/types`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/SuggestForm.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SuggestForm from "./SuggestForm";

describe("SuggestForm", () => {
  it("submits the trimmed name, then calls onCancel", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(<SuggestForm label="New category name" onSubmit={onSubmit} onCancel={onCancel} />);
    const input = screen.getByRole("textbox", { name: "New category name" });
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await userEvent.type(input, "  Cookbooks ");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith("Cookbooks");
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(input).toHaveAttribute("maxlength", "40");
  });
  it("stays open and re-enables when onSubmit rejects; Cancel calls onCancel", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("dup"));
    const onCancel = vi.fn();
    render(<SuggestForm label="New category name" onSubmit={onSubmit} onCancel={onCancel} />);
    await userEvent.type(screen.getByRole("textbox"), "Fiction");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

Add to `web/src/components/BookDetail.test.tsx` (update the existing `render(<BookDetail …/>)` calls to pass the three new props: `categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}}` — with `categories={[]}` their assertions are unchanged), then:

```tsx
  const cats = ["Fiction", "Security & Hacking", "TTRPG"];
  it("renders the category as text when no categories are available", () => {
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}} />);
    expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();
    expect(screen.getByText(/Security & Hacking · Hacking by No Starch Press/)).toBeInTheDocument();
  });
  it("moves the book via the category select", async () => {
    const onChangeCategory = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={onChangeCategory} onSuggest={async () => {}} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    expect(select).toHaveValue("Security & Hacking");
    await userEvent.selectOptions(select, "TTRPG");
    expect(onChangeCategory).toHaveBeenCalledWith(book, "TTRPG");
  });
  it("shows the suggest form from the last option and submits with the book id", async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined);
    render(<BookDetail book={book} onClose={() => {}} onDownload={async () => {}} categories={cats} onChangeCategory={async () => {}} onSuggest={onSuggest} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "__suggest__");
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Cookbooks");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSuggest).toHaveBeenCalledWith("Cookbooks", "1");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull());
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("Security & Hacking");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/SuggestForm.test.tsx src/components/BookDetail.test.tsx`
Expected: FAIL — `SuggestForm` missing; BookDetail has no combobox.

- [ ] **Step 3: Write `SuggestForm`**

```tsx
// web/src/components/SuggestForm.tsx
import { useState, type FormEvent } from "react";

interface Props {
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

export const CATEGORY_NAME_MAX = 40;

// One-field inline form used for "suggest a category" (from a book or free-standing)
// and the admin "add category" action. The parent owns toasts; a rejected onSubmit
// simply leaves the form open.
export default function SuggestForm({ label, onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onCancel();
    } catch {
      setBusy(false);
    }
  }

  return (
    <form className="suggest-form" onSubmit={(e) => void submit(e)}>
      <input type="text" aria-label={label} placeholder={label} value={name} maxLength={CATEGORY_NAME_MAX}
        autoFocus disabled={busy} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn" disabled={!trimmed || busy}>Submit</button>
      <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </form>
  );
}
```

- [ ] **Step 4: Update `BookDetail`**

Replace the `Props` interface and the category line. New `Props`:

```tsx
interface Props {
  book: Book | null;
  onClose: () => void;
  onDownload: (book: Book, format: string) => Promise<void>;
  categories: string[];
  onChangeCategory: (book: Book, category: string) => Promise<void>;
  onSuggest: (name: string, bookId: string) => Promise<void>;
}

export const SUGGEST_OPTION = "__suggest__";
```

Add state next to `busy`: `const [suggesting, setSuggesting] = useState(false);` and reset it in the existing `useEffect` (`setSuggesting(false);` beside `setBusy(false);`). Add the handler after `download`:

```tsx
  async function changeCategory(value: string) {
    if (value === SUGGEST_OPTION) { setSuggesting(true); return; }
    setBusy(true);
    try {
      await onChangeCategory(book!, value);
    } finally {
      setBusy(false);
    }
  }
```

Replace `<p className="meta">{book.category} · {book.bundle}</p>` with:

```tsx
          {categories.length === 0 ? (
            <p className="meta">{book.category} · {book.bundle}</p>
          ) : (
            <p className="meta category-row">
              <select aria-label="Category" value={suggesting ? SUGGEST_OPTION : book.category} disabled={busy}
                onChange={(e) => void changeCategory(e.target.value)}>
                {!categories.includes(book.category) && <option value={book.category}>{book.category}</option>}
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value={SUGGEST_OPTION}>Suggest a new category…</option>
              </select>
              {" · "}{book.bundle}
            </p>
          )}
          {suggesting && (
            <SuggestForm label="New category name" onSubmit={(name) => onSuggest(name, book!.id)} onCancel={() => setSuggesting(false)} />
          )}
```

and `import SuggestForm from "./SuggestForm";`. Append to `web/src/styles.css`:

```css
.suggest-form { display: flex; gap: 0.4rem; margin: 0.4rem 0 0.8rem; flex-wrap: wrap; }
.suggest-form input { flex: 1 1 10rem; min-width: 0; padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); }
.category-row select { padding: 0.2rem 0.4rem; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS. (`Library.tsx` will fail to typecheck until it passes the new BookDetail props — add `categories={[]} onChangeCategory={async () => {}} onSuggest={async () => {}}` to the `<BookDetail …/>` in `Library.tsx` now; Task 10 replaces them.)

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SuggestForm.tsx web/src/components/SuggestForm.test.tsx web/src/components/BookDetail.tsx web/src/components/BookDetail.test.tsx web/src/components/Library.tsx web/src/styles.css
git commit -m "feat(web): category select and suggestion form in the book detail"
```

---

### Task 9: `CategorySuggestions` footer and `FacetGroup.footer`

**Files:**
- Create: `web/src/components/CategorySuggestions.tsx`
- Modify: `web/src/components/FacetGroup.tsx`
- Modify: `web/src/styles.css` (append)
- Test: `web/src/components/CategorySuggestions.test.tsx`, `web/src/components/FacetGroup.test.tsx`

**Interfaces:**
- Consumes: `SuggestForm` (Task 8), `Suggestion` and `suggesterLabel` from `../catalog/library` (Task 6).
- Produces:
  - `FacetGroup` prop `footer?: ReactNode`, rendered last inside the `<section>`; the group still returns `null` when `options` is empty **and** no footer is given.
  - `CategorySuggestions` props `{ suggestions: Suggestion[]; isAdmin: boolean; onSuggest: (name: string) => Promise<void>; onCreate: (name: string) => Promise<void>; onResolve: (id: string, action: "accept" | "reject") => Promise<void> }`. Buttons: `Suggest a category`, admin-only `Add category`, and per chip admin-only `Accept <name>` / `Reject <name>` (aria-labels). Chip text: `<name> · suggested by <local part>`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/CategorySuggestions.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CategorySuggestions from "./CategorySuggestions";

const suggestions = [
  { id: "s1", name: "Cookbooks", bookId: "b1", suggestedBy: "zbmowrey@gmail.com", createdAt: "2026-09-04T00:00:00Z" },
  { id: "s2", name: "Poetry", suggestedBy: "x@y", createdAt: "2026-09-04T00:00:01Z" },
];
const noop = async () => {};

describe("CategorySuggestions", () => {
  it("lists pending chips with the suggester's local part and hides admin controls", () => {
    render(<CategorySuggestions suggestions={suggestions} isAdmin={false} onSuggest={noop} onCreate={noop} onResolve={noop} />);
    expect(screen.getByText("Cookbooks · suggested by zbmowrey")).toBeInTheDocument();
    expect(screen.getByText("Poetry · suggested by x")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept Cookbooks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add category" })).toBeNull();
  });
  it("opens the suggest form and submits a free-standing suggestion", async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined);
    render(<CategorySuggestions suggestions={[]} isAdmin={false} onSuggest={onSuggest} onCreate={noop} onResolve={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest a category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Poetry");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSuggest).toHaveBeenCalledWith("Poetry");
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
  it("admins can accept, reject, and add directly", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CategorySuggestions suggestions={suggestions} isAdmin onSuggest={noop} onCreate={onCreate} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept Cookbooks" }));
    expect(onResolve).toHaveBeenCalledWith("s1", "accept");
    await userEvent.click(screen.getByRole("button", { name: "Reject Poetry" }));
    expect(onResolve).toHaveBeenCalledWith("s2", "reject");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Category name" }), "Essays");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onCreate).toHaveBeenCalledWith("Essays");
  });
});
```

Add to `web/src/components/FacetGroup.test.tsx`:

```tsx
  it("renders the footer after the options, even when there are no options", () => {
    const { rerender } = render(<FacetGroup title="Category" options={[{ value: "Fiction", count: 1 }]} selected={new Set()} onToggle={() => {}} footer={<span>FOOT</span>} />);
    expect(screen.getByText("FOOT")).toBeInTheDocument();
    rerender(<FacetGroup title="Category" options={[]} selected={new Set()} onToggle={() => {}} footer={<span>FOOT</span>} />);
    expect(screen.getByText("FOOT")).toBeInTheDocument();
    rerender(<FacetGroup title="Category" options={[]} selected={new Set()} onToggle={() => {}} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/CategorySuggestions.test.tsx src/components/FacetGroup.test.tsx`
Expected: FAIL — module missing; footer not rendered.

- [ ] **Step 3: Implement**

`FacetGroup.tsx`: add `import { useState, type ReactNode } from "react";`, add `footer?: ReactNode;` to `Props`, destructure `footer`, change the early return to `if (options.length === 0 && !footer) return null;`, and render `{footer}` as the last child of `<section className="facet">`.

```tsx
// web/src/components/CategorySuggestions.tsx
import { useState } from "react";
import { suggesterLabel, type Suggestion } from "../catalog/library";
import SuggestForm from "./SuggestForm";

interface Props {
  suggestions: Suggestion[];
  isAdmin: boolean;
  onSuggest: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onResolve: (id: string, action: "accept" | "reject") => Promise<void>;
}

type Mode = "idle" | "suggest" | "create";

// Footer of the Category facet: pending suggestions (so nobody duplicates one),
// a free-standing "suggest" form, and — for admins — accept/reject and add-directly.
export default function CategorySuggestions({ suggestions, isAdmin, onSuggest, onCreate, onResolve }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [resolving, setResolving] = useState<string>();

  async function resolve(id: string, action: "accept" | "reject") {
    setResolving(id);
    try {
      await onResolve(id, action);
    } finally {
      setResolving(undefined);
    }
  }

  return (
    <div className="category-footer">
      {suggestions.length > 0 && (
        <ul className="chips" aria-label="Pending category suggestions">
          {suggestions.map((s) => (
            <li key={s.id} className="chip">
              <span>{s.name} · suggested by {suggesterLabel(s.suggestedBy)}</span>
              {isAdmin && (
                <span className="chip-actions">
                  <button type="button" aria-label={`Accept ${s.name}`} title="Accept" disabled={resolving === s.id}
                    onClick={() => void resolve(s.id, "accept")}>✓</button>
                  <button type="button" aria-label={`Reject ${s.name}`} title="Reject" disabled={resolving === s.id}
                    onClick={() => void resolve(s.id, "reject")}>✗</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode === "idle" && (
        <div className="footer-links">
          <button type="button" className="more" onClick={() => setMode("suggest")}>Suggest a category</button>
          {isAdmin && <button type="button" className="more" onClick={() => setMode("create")}>Add category</button>}
        </div>
      )}
      {mode === "suggest" && <SuggestForm label="New category name" onSubmit={onSuggest} onCancel={() => setMode("idle")} />}
      {mode === "create" && <SuggestForm label="Category name" onSubmit={onCreate} onCancel={() => setMode("idle")} />}
    </div>
  );
}
```

Append to `web/src/styles.css`:

```css
.category-footer { margin-top: 0.4rem; }
.category-footer .footer-links { display: flex; gap: 0.8rem; }
.chips { list-style: none; padding: 0; margin: 0.3rem 0; display: flex; flex-direction: column; gap: 0.25rem; }
.chip { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--muted); background: var(--bg); border: 1px dashed var(--border); border-radius: 999px; padding: 0.15rem 0.6rem; }
.chip-actions button { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0 0.2rem; font-size: 0.9rem; }
.chip-actions button:disabled { opacity: 0.5; cursor: default; }
```

(If `--bg` is not defined in `styles.css`, use `var(--panel)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/CategorySuggestions.tsx web/src/components/CategorySuggestions.test.tsx web/src/components/FacetGroup.tsx web/src/components/FacetGroup.test.tsx web/src/styles.css
git commit -m "feat(web): pending-suggestion chips and admin controls under the category facet"
```

---

### Task 10: Library integration — load, merge, mutate, refetch

**Files:**
- Modify: `web/src/components/Library.tsx`
- Test: `web/src/components/Library.test.tsx`

**Interfaces:**
- Consumes: `fetchOverlay`, `applyOverlay`, `setBookCategory`, `suggestCategory`, `createCategory`, `resolveSuggestion`, `Overlay` (Task 6); `BookDetail` props (Task 8); `FacetGroup.footer` + `CategorySuggestions` (Task 9); `isAdmin` prop (Task 7).
- Produces: the user-facing behaviour in the spec's "Web UI" section. Toast copy (exact): `Moved to <category>`, `Suggested '<name>' — waiting for approval`, `Added category '<name>'`, `Accepted '<name>'`, `Rejected '<name>'`, and on overlay failure `Category editing is unavailable right now (<message>)`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/Library.test.tsx`, add an overlay fixture and teach `fetchFor` about the new routes. Replace the existing `fetchFor` with:

```tsx
const overlay = {
  categories: [{ name: "Fiction", source: "seed" }, { name: "Security & Hacking", source: "seed" }, { name: "TTRPG", source: "seed" }],
  bookCategories: {},
  suggestions: [{ id: "s1", name: "Cookbooks", suggestedBy: "zbmowrey@gmail.com", createdAt: "2026-09-04T00:00:00Z" }],
};

type Handler = (url: string, init?: RequestInit) => Promise<unknown> | unknown;
function fetchFor(catalogBody: object, downloadBody: object = { url: "https://s3/x", filename: "f.epub", expiresIn: 900 }, extra: Record<string, Handler> = {}) {
  const jsonRes = (status: number, body: unknown) => ({
    ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body,
  });
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const key = `${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`;
    for (const [pattern, handler] of Object.entries(extra)) if (new RegExp(pattern).test(key)) return handler(u, init);
    if (u.endsWith("/session")) return { ok: true, status: 204, headers: new Headers() };
    if (u.endsWith("/library")) return jsonRes(200, overlay);
    if (u.endsWith("/catalog.json")) return jsonRes(200, catalogBody);
    return jsonRes(200, downloadBody);
  }) as unknown as typeof fetch;
}
```

The other tests in the file build their own `fetchFn`s that return the catalog for every non-session URL; give each of them a `/library` branch: `if (String(url).endsWith("/library")) return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => overlay };` placed right after the `/session` branch (the "catalog cannot load" test is the exception — leave it, the catalog error must win). In "establishes a session before loading the catalog", also assert `expect(calls.indexOf("GET /catalog.json")).toBeLessThan(calls.indexOf("GET /api/library"));`.

Then add these tests:

```tsx
  it("merges the overlay into categories and lists categories in the detail select", async () => {
    const fetchFn = fetchFor(catalog, undefined, { "GET /library$": () => ({
      ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ...overlay, bookCategories: { "1": "TTRPG" } }),
    }) });
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /TTRPG/ })).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: /Security & Hacking/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const select = within(screen.getByRole("dialog", { hidden: true })).getByRole("combobox", { name: "Category" });
    expect(select).toHaveValue("TTRPG");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Fiction", "Security & Hacking", "TTRPG", "Suggest a new category…"]);
  });

  it("moves a book: PUTs, re-fetches the overlay, updates the grid and the open dialog, toasts", async () => {
    let bookCategories: Record<string, string> = {};
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/1/category$": (_u, init) => { bookCategories = { "1": JSON.parse(String(init?.body)).category }; return { ok: true, status: 204, headers: new Headers() }; },
      "GET /library$": () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ...overlay, bookCategories }) }),
    });
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to TTRPG"));
    expect(within(dialog).getByRole("combobox", { name: "Category" })).toHaveValue("TTRPG");
    expect(screen.getByRole("checkbox", { name: /TTRPG/ })).toBeInTheDocument();
    const put = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(put[1].headers.Authorization).toBe("Bearer tok");
  });

  it("toasts the API error and keeps the old category when the move fails", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "PUT /books/": () => ({ ok: false, status: 400, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "Unknown category" }) }),
    });
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "TTRPG");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unknown category"));
    expect(within(dialog).getByRole("combobox", { name: "Category" })).toHaveValue("Security & Hacking");
  });

  it("suggests from the facet footer and shows pending chips; admin controls only with isAdmin", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "POST /suggestions$": () => ({ ok: true, status: 201, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ id: "s2" }) }),
    });
    const { rerender } = render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByText("Cookbooks · suggested by zbmowrey")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Accept Cookbooks" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Suggest a category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New category name" }), "Poetry");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Suggested 'Poetry' — waiting for approval"));
    const post = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith("/suggestions"))!;
    expect(JSON.parse(post[1].body)).toEqual({ name: "Poetry" });
    rerender(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} isAdmin />);
    expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeInTheDocument();
  });

  it("admin accepts a suggestion and adds a category directly", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "POST /suggestions/s1/accept$": () => ({ ok: true, status: 204, headers: new Headers() }),
      "POST /categories$": () => ({ ok: true, status: 201, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ name: "Essays" }) }),
    });
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} isAdmin />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept Cookbooks" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Accept Cookbooks" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Accepted 'Cookbooks'"));
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Category name" }), "Essays");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added category 'Essays'"));
    const libraryCalls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/library"));
    expect(libraryCalls.length).toBe(3); // initial + one refetch per mutation
  });

  it("still renders read-only when the overlay fails, with a toast", async () => {
    const fetchFn = fetchFor(catalog, undefined, {
      "GET /library$": () => ({ ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ error: "boom" }) }),
    });
    render(<Library apiUrl="https://api" getIdToken={async () => "tok"} fetchFn={fetchFn} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Category editing is unavailable right now (boom)");
    expect(screen.queryByRole("button", { name: "Suggest a category" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    expect(within(screen.getByRole("dialog", { hidden: true })).queryByRole("combobox", { name: "Category" })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/Library.test.tsx`
Expected: the new tests FAIL (no overlay fetch, no combobox, no chips); pre-existing tests still pass.

- [ ] **Step 3: Implement in `Library.tsx`**

Imports to add:

```tsx
import {
  applyOverlay, createCategory, fetchOverlay, resolveSuggestion, setBookCategory, suggestCategory, type Overlay,
} from "../catalog/library";
import CategorySuggestions from "./CategorySuggestions";
```

State changes: replace `const [selected, setSelected] = useState<Book | null>(null);` with `const [selectedId, setSelectedId] = useState<string | null>(null);` and add `const [overlay, setOverlay] = useState<Overlay | null>(null);`.

Overlay loading — add a helper inside the component and call it from the catalog-loading effect right after `setBooks(catalog.books)`:

```tsx
  const refreshOverlay = useCallback(async () => {
    setOverlay(await fetchOverlay(apiUrl, await getIdToken(), fetchFn));
  }, [apiUrl, getIdToken, fetchFn]);
```

In the load effect, after `if (!cancelled) setBooks(catalog.books);` add:

```tsx
        try {
          const o = await fetchOverlay(apiUrl, await getIdToken(), fetchFn);
          if (!cancelled) setOverlay(o);
        } catch (e) {
          // A broken library Lambda must not take the site down: render read-only.
          if (!cancelled) setToast(`Category editing is unavailable right now (${(e as Error).message})`);
        }
```

Derived data — right after the state declarations:

```tsx
  const merged = useMemo(() => (books && overlay ? applyOverlay(books, overlay) : books), [books, overlay]);
  const categoryNames = useMemo(() => overlay?.categories.map((c) => c.name) ?? [], [overlay]);
  const selected = useMemo(() => merged?.find((b) => b.id === selectedId) ?? null, [merged, selectedId]);
```

Then replace every use of `books` in the `facets`, `filtered` memos with `merged` (and their dependency arrays), keep `if (!books) return <p className="empty">Loading the library…</p>;` as is.

Mutation callbacks (after `download`):

```tsx
  // Every mutation re-fetches the overlay rather than patching local state: one
  // code path, and the server's view always wins (which is also the "revert" on failure).
  const mutate = useCallback(async (run: (token: string) => Promise<void>, success: string) => {
    try {
      await run(await getIdToken());
      await refreshOverlay();
      setToast(success);
    } catch (e) {
      setToast((e as Error).message);
    }
  }, [getIdToken, refreshOverlay]);

  const changeCategory = useCallback((book: Book, category: string) =>
    mutate((t) => setBookCategory(apiUrl, t, book.id, category, fetchFn), `Moved to ${category}`), [mutate, apiUrl, fetchFn]);
  const suggest = useCallback((name: string, bookId?: string) =>
    mutate((t) => suggestCategory(apiUrl, t, name, bookId, fetchFn), `Suggested '${name}' — waiting for approval`), [mutate, apiUrl, fetchFn]);
  const addCategory = useCallback((name: string) =>
    mutate((t) => createCategory(apiUrl, t, name, fetchFn), `Added category '${name}'`), [mutate, apiUrl, fetchFn]);
  const resolve = useCallback((id: string, action: "accept" | "reject") => {
    const name = overlay?.suggestions.find((s) => s.id === id)?.name ?? "suggestion";
    return mutate((t) => resolveSuggestion(apiUrl, t, id, action, fetchFn), `${action === "accept" ? "Accepted" : "Rejected"} '${name}'`);
  }, [mutate, apiUrl, fetchFn, overlay]);
```

`mutate` swallows errors (it toasts them), so `SuggestForm` closes even after a failed suggest — the toast carries the reason and the refetched chips reflect reality. This is the intended behaviour; `SuggestForm`'s own stay-open-on-reject logic (Task 8) still applies wherever a caller rethrows.

Rendering: the sidebar loop becomes

```tsx
        {FACET_KEYS.map((key) => (
          <FacetGroup key={key} title={FACET_TITLES[key]} options={facets[key]}
            selected={filters[key]} onToggle={(v) => toggle(key, v)}
            footer={key === "category" && overlay ? (
              <CategorySuggestions suggestions={overlay.suggestions} isAdmin={isAdmin}
                onSuggest={(name) => suggest(name)} onCreate={addCategory} onResolve={resolve} />
            ) : undefined} />
        ))}
```

`BookCard`'s `onOpen={setSelected}` becomes `onOpen={(b) => setSelectedId(b.id)}`, and the dialog becomes

```tsx
      <BookDetail book={selected} onClose={() => setSelectedId(null)} onDownload={download}
        categories={categoryNames} onChangeCategory={changeCategory} onSuggest={(name, bookId) => suggest(name, bookId)} />
```

`visible` must come from `merged` (it does, via `filtered`).

- [ ] **Step 4: Run the whole web suite, typecheck, and build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS; build succeeds (`VITE_*` env comes from `web/.env.production.local` on this machine).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Library.tsx web/src/components/Library.test.tsx
git commit -m "feat(web): load the category overlay, move books, suggest and manage categories"
```

---

### Task 11: Indexer accepts `categories:` from overrides; config and scripts learn the table

**Files:**
- Modify: `indexer/src/ebook_indexer/categorize.py`
- Modify: `indexer/src/ebook_indexer/config.py`
- Modify: `scripts/apply-outputs.py`
- Modify: `scripts/backup.sh`
- Modify: `config.example.yaml`
- Test: `indexer/tests/test_categorize.py`, `indexer/tests/test_apply_outputs.py`

**Interfaces:**
- Produces: `BUILTIN_CATEGORIES: frozenset[str]` (the seven built-ins), `valid_categories(overrides: dict) -> set[str]` (built-ins ∪ `overrides.get("categories", [])`); `Config.library_table: str`; `config.yaml` key `library_table`; `apply-outputs.py` maps `library_table` ← `LibraryTable` and **appends** a missing key line instead of failing; `backup.sh` exports the library table to `_backup/dynamodb/library-<stamp>.json` when the output exists.

- [ ] **Step 1: Write the failing tests**

Append to `indexer/tests/test_categorize.py`:

```python
from ebook_indexer.categorize import BUILTIN_CATEGORIES, valid_categories


def test_categories_key_extends_the_valid_set_and_is_not_a_book():
    ov = {"categories": ["Cookbooks", "Poetry"], "abc123": {"category": "Cookbooks"}}
    assert valid_categories(ov) == BUILTIN_CATEGORIES | {"Cookbooks", "Poetry"}
    b = book()
    apply_overrides(b, ov)
    assert b.category == "Cookbooks"


def test_unknown_category_override_is_still_ignored():
    b = book()
    apply_overrides(b, {"abc123": {"category": "Not A Category"}})
    assert b.category == "Other/Lifestyle"


def test_valid_categories_without_the_key_is_the_builtin_set():
    assert valid_categories({}) == BUILTIN_CATEGORIES
    assert valid_categories({"categories": None}) == BUILTIN_CATEGORIES
```

Replace the body of `test_apply_outputs_rewrites_only_the_aws_keys` in `indexer/tests/test_apply_outputs.py` so the outputs include `"LibraryTable": "lib-789"` and the config text has **no** `library_table` line; after running, assert additionally:

```python
    assert data["library_table"] == "lib-789"          # appended because the line was missing
    assert config.read_text().rstrip().endswith('library_table: "lib-789"')
```

and add a second test:

```python
def test_apply_outputs_rewrites_an_existing_library_table_line(tmp_path):
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"EbookShare": {
        "SiteBucketName": "s", "BooksBucketName": "b", "DistributionId": "d", "LibraryTable": "lib-new",
    }}))
    config = tmp_path / "config.yaml"
    config.write_text(
        "library_root: /lib\noutput_dir: out\nmetadata_dir: metadata\naws_region: us-east-1\n"
        "books_bucket: \"\"\nsite_bucket: \"\"\ncloudfront_distribution_id: \"\"\n"
        "library_table: \"lib-old\"   # category overlay table\n"
    )
    subprocess.run([sys.executable, str(SCRIPT), str(outputs), str(config)], check=True)
    text = config.read_text()
    assert 'library_table: "lib-new"  # category overlay table' in text
    assert text.count("library_table:") == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd indexer && .venv/bin/pytest -q tests/test_categorize.py tests/test_apply_outputs.py`
Expected: FAIL — `ImportError: cannot import name 'BUILTIN_CATEGORIES'`; apply-outputs exits 1 on the missing line.

- [ ] **Step 3: Implement**

`indexer/src/ebook_indexer/categorize.py` — replace the `_VALID_CATEGORIES` line and `apply_overrides`:

```python
BUILTIN_CATEGORIES = frozenset({TECH, SECURITY, FICTION, COMICS, TTRPG, CERT, OTHER})


def valid_categories(overrides: dict) -> set[str]:
    """Built-in categories plus the top-level ``categories:`` list in overrides.yaml.

    scripts/pull-edits.py maintains that list from the site's category table, so
    categories people created through the site survive a re-index.
    """
    extra = overrides.get("categories") or []
    return set(BUILTIN_CATEGORIES) | {str(c) for c in extra}


def apply_overrides(book: Book, overrides: dict) -> None:
    valid = valid_categories(overrides)
    for field_name, value in (overrides.get(book.id) or {}).items():
        if field_name not in _OVERRIDABLE:
            continue
        if field_name == "category" and value not in valid:
            continue  # not a known category string; keep the derived category
        if field_name == "authors" and isinstance(value, str):
            value = [value]
        setattr(book, field_name, value)
```

Also update the header comment at the top of `metadata/overrides.yaml` (it lists the valid categories) to add: `# A top-level "categories:" list adds site-created categories (maintained by scripts/pull-edits.py).`

`indexer/src/ebook_indexer/config.py` — add `library_table: str` after `cloudfront_distribution_id` in the dataclass and `library_table=raw.get("library_table") or "",` in `load_config`.

`config.example.yaml` — append: `library_table: ""           # category overlay table (scripts/pull-edits.py, scripts/backup.sh)`.

`scripts/apply-outputs.py` — add `"library_table": "LibraryTable",` to `KEY_MAP`, and replace the "no line" error with an append:

```python
        if not pattern.search(text):
            if not text.endswith("\n"):
                text += "\n"
            text += f'{yaml_key}: "{value}"\n'
            continue
```

`scripts/backup.sh` — change the `read -r BUCKET TABLE` line to also read the library table (empty when the stack output does not exist yet):

```bash
read -r BUCKET TABLE LIBTABLE < <(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['BooksBucketName'], o['DownloadsTable'], o.get('LibraryTable',''))")
```

and after the downloads export block add:

```bash
if [ -n "$LIBTABLE" ]; then
  if [ "$DRY" = "--dry-run" ]; then
    echo "(dryrun) would export DynamoDB table $LIBTABLE to $DEST/dynamodb/library-$STAMP.json"
  else
    LTMP=$(mktemp)
    aws dynamodb scan --table-name "$LIBTABLE" --region "$REGION" --output json > "$LTMP"
    aws s3 cp "$LTMP" "$DEST/dynamodb/library-$STAMP.json" --region "$REGION" >/dev/null
    echo "exported $(python3 -c "import json;print(len(json.load(open('$LTMP'))['Items']))") library rows"
    rm -f "$LTMP"
  fi
fi
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd indexer && .venv/bin/pytest -q && bash -n ../scripts/backup.sh`
Expected: all PASS; `bash -n` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add indexer/src/ebook_indexer/categorize.py indexer/src/ebook_indexer/config.py indexer/tests/test_categorize.py indexer/tests/test_apply_outputs.py scripts/apply-outputs.py scripts/backup.sh config.example.yaml metadata/overrides.yaml
git commit -m "feat(indexer): site-created categories via overrides.yaml; scripts learn the library table"
```

---

### Task 12: `scripts/pull-edits.py`

**Files:**
- Create: `scripts/pull-edits.py`
- Test: `indexer/tests/test_pull_edits.py`

**Interfaces:**
- Consumes: `config.yaml` keys `library_table`, `aws_region`, `metadata_dir`, `output_dir` (via `ebook_indexer.config.load_config` — the script adds `indexer/src` to `sys.path` the same way it would be run from the repo root; see code).
- Produces: CLI `scripts/pull-edits.py [--config config.yaml] [--input scan.json] [--dry-run]`. `--input` reads a DynamoDB **typed** scan JSON (`aws dynamodb scan --output json`, i.e. what `backup.sh` writes) instead of calling AWS, which is what the test uses. Writes `metadata/overrides.yaml` with: header comment preserved, `categories:` = sorted table category names (excluding the seven built-ins), each `BOOK` item's `category` merged into its id's entry (other fields untouched). Prints `merged N book categories, M site categories` and, per orphan (a `BOOK` id absent from `out/catalog.json` when that file exists), `orphan: <id> (<category>)`. Exit 0.

- [ ] **Step 1: Write the failing test**

```python
# indexer/tests/test_pull_edits.py
import json
import subprocess
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "pull-edits.py"

HEADER = "# Manual metadata overrides. Keyed by book id.\n# Keep this comment.\n"


def s(v):
    return {"S": v}


def scan(items):
    return {"Items": items, "Count": len(items), "ScannedCount": len(items)}


def setup(tmp_path):
    meta = tmp_path / "metadata"
    out = tmp_path / "out"
    meta.mkdir()
    out.mkdir()
    (meta / "overrides.yaml").write_text(
        HEADER + "aaaa:\n  title: Keep Me\n  category: Fiction\nbbbb:\n  year: 1999\n"
    )
    (out / "catalog.json").write_text(json.dumps({"books": [{"id": "aaaa"}, {"id": "bbbb"}, {"id": "cccc"}]}))
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        f"library_root: {tmp_path}\noutput_dir: out\nmetadata_dir: metadata\n"
        "aws_region: us-east-1\nlibrary_table: lib\n"
    )
    scan_file = tmp_path / "scan.json"
    scan_file.write_text(json.dumps(scan([
        {"pk": s("CATEGORY"), "sk": s("Fiction"), "source": s("seed")},
        {"pk": s("CATEGORY"), "sk": s("Cookbooks"), "source": s("admin")},
        {"pk": s("CATEGORY"), "sk": s("Poetry"), "source": s("suggestion")},
        {"pk": s("BOOK"), "sk": s("aaaa"), "category": s("Cookbooks"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("BOOK"), "sk": s("cccc"), "category": s("Poetry"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("BOOK"), "sk": s("zzzz"), "category": s("Fiction"), "changedBy": s("u@x"), "changedAt": s("t")},
        {"pk": s("SUGGESTION"), "sk": s("s1"), "name": s("Essays"), "status": s("pending")},
    ])))
    return cfg, scan_file, meta / "overrides.yaml"


def run(cfg, scan_file, *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--config", str(cfg), "--input", str(scan_file), *extra],
        check=True, capture_output=True, text=True,
    ).stdout


def test_merges_book_categories_and_site_categories_and_reports_orphans(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    out = run(cfg, scan_file)
    text = overrides.read_text()
    assert text.startswith(HEADER)
    data = yaml.safe_load(text)
    assert data["categories"] == ["Cookbooks", "Poetry"]  # built-ins excluded, sorted
    assert data["aaaa"] == {"title": "Keep Me", "category": "Cookbooks"}
    assert data["bbbb"] == {"year": 1999}  # untouched
    assert data["cccc"] == {"category": "Poetry"}
    assert data["zzzz"] == {"category": "Fiction"}  # written, but reported
    assert "merged 3 book categories, 2 site categories" in out
    assert "orphan: zzzz (Fiction)" in out
    assert "orphan: cccc" not in out


def test_dry_run_changes_nothing(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    before = overrides.read_text()
    out = run(cfg, scan_file, "--dry-run")
    assert overrides.read_text() == before
    assert "merged 3 book categories" in out


def test_is_idempotent(tmp_path):
    cfg, scan_file, overrides = setup(tmp_path)
    run(cfg, scan_file)
    once = overrides.read_text()
    run(cfg, scan_file)
    assert overrides.read_text() == once
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd indexer && .venv/bin/pytest -q tests/test_pull_edits.py`
Expected: FAIL — script not found (`FileNotFoundError` / non-zero exit).

- [ ] **Step 3: Write the script**

```python
#!/usr/bin/env python3
"""Fold the site's category edits back into metadata/overrides.yaml.

The site stores category changes and site-created categories in the DynamoDB
library table (see docs/superpowers/specs/2026-09-04-user-categories-design.md).
This script copies them into overrides.yaml so the repo's metadata stays a
faithful backup and the next index/publish converges on what people chose.

Usage: scripts/pull-edits.py [--config config.yaml] [--input scan.json] [--dry-run]
  --input   read a DynamoDB typed scan (aws dynamodb scan --output json) instead of AWS
  --dry-run print what would change without writing
"""
import argparse
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "indexer" / "src"))
from ebook_indexer.categorize import BUILTIN_CATEGORIES  # noqa: E402
from ebook_indexer.config import load_config  # noqa: E402


def _plain(attr: dict):
    """Unwrap one DynamoDB typed attribute ({"S": "x"} -> "x"); strings are all we store."""
    if "S" in attr:
        return attr["S"]
    if "N" in attr:
        return attr["N"]
    if "BOOL" in attr:
        return attr["BOOL"]
    return None


def load_items(args, cfg) -> list[dict]:
    if args.input:
        raw = json.loads(Path(args.input).read_text())["Items"]
    else:
        import boto3  # only needed when talking to AWS
        client = boto3.client("dynamodb", region_name=cfg.aws_region)
        raw, kwargs = [], {"TableName": cfg.library_table}
        while True:
            page = client.scan(**kwargs)
            raw.extend(page["Items"])
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return [{k: _plain(v) for k, v in item.items()} for item in raw]


def split_header(text: str) -> tuple[str, dict]:
    """Return the leading comment/blank lines verbatim and the parsed mapping."""
    lines = text.splitlines(keepends=True)
    n = 0
    while n < len(lines) and (lines[n].startswith("#") or not lines[n].strip()):
        n += 1
    return "".join(lines[:n]), (yaml.safe_load("".join(lines[n:])) or {})


def merge(overrides: dict, items: list[dict]) -> tuple[dict, list[str], dict[str, str]]:
    site_categories = sorted(
        i["sk"] for i in items if i.get("pk") == "CATEGORY" and i["sk"] not in BUILTIN_CATEGORIES
    )
    books = {i["sk"]: i["category"] for i in items if i.get("pk") == "BOOK"}
    merged = dict(overrides)
    if site_categories:
        merged["categories"] = site_categories
    else:
        merged.pop("categories", None)
    for book_id, category in books.items():
        entry = dict(merged.get(book_id) or {})
        entry["category"] = category
        merged[book_id] = entry
    return merged, site_categories, books


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--input")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv[1:])

    cfg = load_config(Path(args.config))
    if not args.input and not cfg.library_table:
        print("config.yaml has no library_table (run scripts/apply-outputs.py after deploying)", file=sys.stderr)
        return 1
    items = load_items(args, cfg)

    overrides_path = cfg.metadata_dir / "overrides.yaml"
    header, existing = split_header(overrides_path.read_text()) if overrides_path.exists() else ("", {})
    merged, site_categories, books = merge(existing, items)

    catalog_path = cfg.output_dir / "catalog.json"
    if catalog_path.exists():
        known = {b["id"] for b in json.loads(catalog_path.read_text())["books"]}
        for book_id, category in sorted(books.items()):
            if book_id not in known:
                print(f"orphan: {book_id} ({category})")

    print(f"merged {len(books)} book categories, {len(site_categories)} site categories")
    if args.dry_run:
        return 0
    body = yaml.safe_dump(merged, allow_unicode=True, sort_keys=True, width=100)
    overrides_path.write_text(header + body)
    print(f"wrote {overrides_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

`chmod +x scripts/pull-edits.py`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd indexer && .venv/bin/pytest -q`
Expected: PASS. (The script runs with the test's `sys.executable`; PyYAML is an indexer dependency and is importable from the venv.)

- [ ] **Step 5: Commit**

```bash
git add scripts/pull-edits.py indexer/tests/test_pull_edits.py
git commit -m "feat(scripts): pull-edits.py folds site category edits into overrides.yaml"
```

---

### Task 13: `make-admin.sh` and documentation

**Files:**
- Create: `scripts/make-admin.sh`
- Modify: `README.md`, `infra/README.md`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Add a user who has already signed in to the Cognito "admins" group.
# Admins can accept category suggestions and add categories directly.
# Usage: scripts/make-admin.sh <email>
set -euo pipefail
EMAIL=${1:?usage: $0 <email>}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION=$(python3 -c "import json;print(json.load(open('$ROOT/infra/config.local.json'))['region'])")
POOL=$(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['UserPoolId'])")
# Federated users have usernames like google_1234…; look them up by email.
USERNAME=$(aws cognito-idp list-users --user-pool-id "$POOL" --region "$REGION" \
  --filter "email = \"$EMAIL\"" --query 'Users[0].Username' --output text)
if [ -z "$USERNAME" ] || [ "$USERNAME" = "None" ]; then
  echo "no Cognito user with email $EMAIL — they must sign in to the site once first" >&2
  exit 1
fi
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --region "$REGION" \
  --username "$USERNAME" --group-name admins
echo "added $EMAIL ($USERNAME) to admins — they must sign out and back in to get a token with the group"
```

`chmod +x scripts/make-admin.sh`; `bash -n scripts/make-admin.sh`.

- [ ] **Step 2: Update `README.md`**

In **What it does**, add a bullet after "Instant search":

```markdown
- **Shared, editable categories.** Anyone signed in can move a book to another
  category or suggest a new one; members of a Cognito `admins` group accept
  suggestions or add categories directly. Edits live in a small DynamoDB
  table that the site merges over the static catalog, and
  `scripts/pull-edits.py` folds them back into `metadata/overrides.yaml`.
```

In the **Architecture** mermaid block add a node `LIB[library Lambda]` and `LIBT[(DynamoDB<br/>categories + suggestions)]` inside the `aws` subgraph, plus edges `API --> LIB --> LIBT`. In **Repository layout**, the `scripts/` row gains "make an admin (`make-admin.sh`), pull category edits (`pull-edits.py`)". In **Deploy your own**, add step 8:

```markdown
8. **Make yourself an admin** (after signing in once): `scripts/make-admin.sh you@example.com`, then sign out and back in.
```

In **Security notes**, add: "Category edits are attributed (who/when) and admin actions require the `admins` group claim on the ID token; the API checks it, the UI only hides buttons."

Update the three test-count numbers in **Repository layout** to the real totals after this plan (`npx vitest run` / `pytest` print them).

- [ ] **Step 3: Update `infra/README.md`**

Add a section after "Removing an account":

```markdown
## Admins (category management)

Members of the Cognito group `admins` can accept category suggestions and add
categories directly. Add someone who has already signed in with
`scripts/make-admin.sh <email>`; remove them with
`aws cognito-idp admin-remove-user-from-group --user-pool-id <pool> --username <username> --group-name admins`.
Group membership is read from the ID token, so changes take effect at the next
sign-in (or token refresh, at most an hour).

Category state lives in the `Library/Table` DynamoDB table (retained). The seven
built-in categories are seeded by custom resources on deploy; they are never
deleted or renamed by CDK. `scripts/pull-edits.py` copies edits into
`metadata/overrides.yaml`; `scripts/backup.sh` exports the table.
```

and add `Library/Table — the category overlay table` to the "Construct IDs that must never be renamed" list.

- [ ] **Step 4: Verify and commit**

Run: `bash -n scripts/make-admin.sh && cd infra && npm test`
Expected: no output from `bash -n`; tests pass (README edits touch nothing executable).

```bash
git add scripts/make-admin.sh README.md infra/README.md
git commit -m "docs: admin group, category editing, and the new scripts"
```

---

### Task 14: Deploy and smoke test (controller runs this; needs AWS credentials)

**Files:** none in git except a possible `metadata/overrides.yaml` change from `pull-edits.py`.

- [ ] **Step 1: Deploy infra**

Run: `cd infra && npx cdk diff` — expect: new table, 7 custom resources + provider, new Lambda + role + 6 routes, one `UserPoolGroup`, output `LibraryTable`; **no** replacement of the user pool, buckets, distribution, or downloads table. Then `npm run deploy` and `python3 ../scripts/apply-outputs.py` (adds `library_table` to `config.yaml`).

- [ ] **Step 2: Seed check and admin**

`aws dynamodb query --table-name "$(python3 -c "import json;print(next(iter(json.load(open('infra/outputs.json')).values()))['LibraryTable'])")" --key-condition-expression 'pk = :p' --expression-attribute-values '{":p":{"S":"CATEGORY"}}' --query 'Count'` → `7`.
`scripts/make-admin.sh fatherofash@gmail.com`.

- [ ] **Step 3: Deploy web**

`scripts/deploy-web.sh`, wait for the invalidation.

- [ ] **Step 4: Smoke test (Jay, in a browser)**

Sign out and in → open a book → move it (toast, facet count changes) → "Suggest a new category…" from a book → chip appears → accept it (✓) → book is now in the new category and the category appears in the facet → "Add category" → appears in the select. Second account (any friend): sees the moves and chips, no ✓/✗/Add.

- [ ] **Step 5: Reconcile and back up**

`scripts/pull-edits.py --dry-run`, then without `--dry-run`; `git diff metadata/overrides.yaml` should show the `categories:` list and the moved books; `cd indexer && .venv/bin/pytest -q`; commit `metadata/overrides.yaml` as `chore(metadata): pull category edits from the site`; `scripts/backup.sh`.
