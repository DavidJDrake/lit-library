# Send to Kindle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Send to Kindle" button that emails a book's EPUB/PDF to the user's `@kindle.com` address through SES, a per-user Kindle address, bounce handling that notifies the user and emails engineering, and a shared structured event log for all Lambdas.

**Architecture:** A new `kindle` Lambda (three routes on the existing JWT-protected API) reads the settings row from the library table, streams the object from S3, builds a raw MIME message and sends it through an SES configuration set tagged with the recipient and book id. SES bounce/complaint/reject events go to an SNS topic that triggers a `kindle-events` Lambda which fans out a `kindle_bounce` notification (existing `notify`), logs a structured event, and emails the alerts topic. The SPA gets a `KindleProvider`, a button + inline address form in the book dialog, a `/settings` page, and one renderer entry.

**Tech Stack:** AWS CDK v2 (TypeScript; `aws-ses`, `aws-sns`, `aws-lambda-event-sources`), Lambda Node 22 with `@aws-sdk/client-sesv2` and `@aws-sdk/client-sns` (bundled), React 18 + Vite + vitest + Testing Library, Python 3 glue.

**Spec:** `docs/superpowers/specs/2026-09-05-send-to-kindle-design.md`

## Global Constraints

- Kindle address: `^[A-Za-z0-9._+-]+@kindle\.com$` case-insensitive, stored lowercased; empty string clears. Settings row: library table `pk = USER#<email>`, `sk = SETTINGS`, `{ kindleAddress, updatedAt }`; only the caller's row is ever read or written.
- `KINDLE_MAX_BYTES = 28 * 1024 * 1024` (SES 40 MB raw limit after base64). Formats: EPUB preferred, then PDF; nothing else.
- Statuses: `GET /api/kindle/address` 200 `{kindleAddress|null}`; `PUT` 204 / 400; `POST /api/kindle/send` 202 `{sentTo, format}` / 404 unknown book / 400 `unsupported` / 409 `no_address` / 413 `too_large` (with `bytes`, `limit`) / 502 `not_enabled` (SES "not verified" in sandbox; message `Kindle delivery isn't enabled for everyone yet`) / 502 other SES or S3 failure. Errors are JSON `{ error, message? }`; unexpected → 500 with logged stack. The downloads row (`format: "kindle:<ext>"`) is written **only after** SES accepts.
- MIME: From `KINDLE_SENDER`, To the Kindle address, Subject = book title, one attachment named `<safe title>.<ext>` (`application/epub+zip` / `application/pdf`), SES email tags `recipient=<user email>` and `bookId`; sent with the `kindle` configuration set.
- Event logging: `logEvent(name, fields)` prints one JSON line `{"event", "at", ...fields}`; never file contents or another user's settings. Events: `kindle.sent`, `kindle.send_failed`, `kindle.oversize`, `kindle.bounce`, plus retrofits `download.issued`, `suggestion.created|accepted|rejected`, `category.created`, `notification.fanout`.
- Bounce handling: `Bounce`/`Complaint`/`Reject` → `notify([recipient], "kindle_bounce", {bookId, kind, reason})` with the notification id = the SES message id (idempotent), `logEvent("kindle.bounce", …)`, and an SNS publish to the alerts topic. Records without a `recipient` tag are ignored.
- Sender `config.kindleSender` must be on `config.siteDomain`; exposed to the SPA as `VITE_KINDLE_SENDER` via a `KindleSender` stack output and `scripts/write-web-env.py`.
- Grants exactly as the spec's Infrastructure section; both new Lambdas keep logs 3 months; CDK diff must be additive.
- UI copy (exact): button `Send to Kindle`; sending state `Sending…`; tooltip `Too large for Kindle delivery — download instead`; toast `Sent to <address> — it usually arrives within a couple of minutes`; inline form input label `Your Kindle email`, button `Save and send`, help link `Where do I find this?` → `https://www.amazon.com/hz/mycd/myx#/home/settings/payment`; `kindle_bounce` row text `Your Kindle rejected "<title>" — add <sender> to your approved senders`.
- All suites offline. Baselines: infra 155, web 144, indexer 81. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01FGG3RznqRahHbbNzUDuphK`.
- Never commit real identifiers; example config uses `library@lit.example.com`.

## File map

| File | Responsibility |
|---|---|
| `infra/lambda/shared/log.ts` | `logEvent`. |
| `infra/lambda/download/index.ts`, `infra/lambda/library/index.ts`, `infra/lambda/notifications/fanout.ts` | Retrofit `logEvent` calls. |
| `infra/lib/config.ts`, `infra/config.example.json` | `kindleSender`. |
| `infra/lambda/kindle/lib.ts` | `parseKindleAddress`, `chooseFormat`, `buildMime`, `KINDLE_MAX_BYTES`, `classifySesError`. |
| `infra/lambda/kindle/index.ts` | `KindleStore`/`Deps`, `handle`, production `handler`. |
| `infra/lambda/kindle/store.ts` | `DynamoKindleStore` (settings row on the library table). |
| `infra/lambda/kindle-events/index.ts` | SNS-triggered bounce handler + wiring. |
| `infra/lib/kindle.ts` | `Kindle` construct: SES identity, configuration set, topic, two Lambdas, routes, output. |
| `infra/lib/ebook-share-stack.ts` | wiring. |
| `scripts/write-web-env.py`, `web/vite.config.ts`, `web/src/config.ts`, `web/src/test/setup.ts`, `.github/workflows/ci.yml` | `VITE_KINDLE_SENDER`. |
| `web/src/kindle/api.ts`, `web/src/kindle/KindleProvider.tsx` | client + context. |
| `web/src/components/BookDetail.tsx`, `web/src/components/KindleAddressForm.tsx` | button, states, inline form. |
| `web/src/components/SettingsPage.tsx`, `web/src/components/Header.tsx`, `web/src/App.tsx`, `web/src/components/Library.tsx` | page, link, wiring. |
| `web/src/notifications/render.ts` | `kindle_bounce` entry. |
| `README.md`, `infra/README.md`, `BACKLOG.md` | docs. |

---

### Task 1: `logEvent` helper and retrofit

**Files:**
- Create: `infra/lambda/shared/log.ts`
- Modify: `infra/lambda/download/index.ts`, `infra/lambda/library/index.ts`, `infra/lambda/notifications/fanout.ts`
- Test: `infra/test/log.test.ts`, `infra/test/download-handler.test.ts`, `infra/test/library-handler.test.ts`, `infra/test/notifications-fanout.test.ts`

**Interfaces:**
- Produces: `export function logEvent(name: string, fields?: Record<string, unknown>, now?: () => Date): void` — writes `console.log(JSON.stringify({ ...fields, event: name, at: now().toISOString() }))`.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/log.test.ts
import { describe, expect, it, vi } from "vitest";
import { logEvent } from "../lambda/shared/log";

describe("logEvent", () => {
  it("prints one JSON line with event, at, and the fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("kindle.sent", { email: "a@example.com", bytes: 12 }, () => new Date("2026-09-05T10:00:00.000Z"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: "kindle.sent", at: "2026-09-05T10:00:00.000Z", email: "a@example.com", bytes: 12 });
    spy.mockRestore();
  });
  it("does not let fields override event or at", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("x", { event: "nope", at: "nope" }, () => new Date("2026-09-05T10:00:00.000Z"));
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: "x", at: "2026-09-05T10:00:00.000Z" });
    spy.mockRestore();
  });
});
```

Add one assertion to each existing handler test file, using a `console.log` spy installed in the test (`const log = vi.spyOn(console, "log").mockImplementation(() => {})`, restored after) and a helper `const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])))`:
- `download-handler.test.ts`, in the "returns a presigned url…" test: `expect(events()).toContainEqual(expect.objectContaining({ event: "download.issued", email: "user@example.com", bookId: "abc", format: "epub" }));`
- `library-handler.test.ts`: after a successful suggest → `suggestion.created` with `{ suggestionId: "id-1", by: "u@x" }`; after accept → `suggestion.accepted` `{ suggestionId: "s1", by: "a@x" }` and `category.created` `{ name: "Cookbooks", source: "suggestion" }`; after reject → `suggestion.rejected` `{ suggestionId: "s1" }`; after direct create → `category.created` `{ name: "Essays", source: "admin" }`.
- `notifications-fanout.test.ts`, in the `notify` "resolves…" test: `notification.fanout` with `{ type: "books_added", recipients: 2 }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/log.test.ts test/download-handler.test.ts test/library-handler.test.ts test/notifications-fanout.test.ts`
Expected: FAIL — module missing; no log lines.

- [ ] **Step 3: Implement**

```ts
// infra/lambda/shared/log.ts
// One JSON line per business event, queryable in CloudWatch Logs Insights:
//   filter event like /^kindle\./ | sort @timestamp desc
// Never log file contents or another user's settings.
export function logEvent(name: string, fields: Record<string, unknown> = {}, now: () => Date = () => new Date()): void {
  console.log(JSON.stringify({ ...fields, event: name, at: now().toISOString() }));
}
```

Retrofit (import `logEvent` from `../shared/log`):
- `download/index.ts`: after `deps.logDownload(...)` succeeds → `logEvent("download.issued", { email, bookId: req.bookId, format: req.format }, deps.now);`
- `library/index.ts`: after `putSuggestion` → `logEvent("suggestion.created", { suggestionId: id, by: email, name: n.name }, deps.now)`; after a successful accept → `logEvent("suggestion.accepted", { suggestionId: s.id, by: email }, deps.now)` and `logEvent("category.created", { name: s.name, source: "suggestion", by: email }, deps.now)`; after reject → `logEvent("suggestion.rejected", { suggestionId: s.id, by: email }, deps.now)`; after direct create → `logEvent("category.created", { name: n.name, source: "admin", by: email }, deps.now)`.
- `notifications/fanout.ts`, in `notify` after `putAll` → `logEvent("notification.fanout", { type, recipients: rows.length }, deps.now)`.

- [ ] **Step 4: Run tests, typecheck**

Run: `cd infra && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/shared/log.ts infra/test/log.test.ts infra/lambda/download/index.ts infra/lambda/library/index.ts infra/lambda/notifications/fanout.ts infra/test/download-handler.test.ts infra/test/library-handler.test.ts infra/test/notifications-fanout.test.ts
git commit -m "feat(lambda): structured logEvent helper, adopted by existing handlers"
```

---

### Task 2: `kindleSender` config, stack output, and `VITE_KINDLE_SENDER`

**Files:**
- Modify: `infra/lib/config.ts`, `infra/config.example.json`, `infra/lib/ebook-share-stack.ts`, `scripts/write-web-env.py`, `web/vite.config.ts`, `web/src/config.ts`, `web/src/test/setup.ts`, `.github/workflows/ci.yml`
- Test: `infra/test/config.test.ts`, `infra/test/stack.test.ts`, `indexer/tests/test_write_web_env.py`, `web/src/config.test.ts`

**Interfaces:**
- Produces: `InfraConfig.kindleSender: string` (required; its domain must equal `siteDomain`); stack output `KindleSender`; env `VITE_KINDLE_SENDER`; `AppConfig.kindleSender: string`.

- [ ] **Step 1: Write the failing tests**

`infra/test/config.test.ts` — add (reuse the file's existing temp-file helpers/imports; `EXAMPLE_CONFIG_PATH` is exported from `../lib/config`):

```ts
  it("requires kindleSender to be on the site domain", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
    const file = path.join(tmpdir(), `cfg-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...example, cloudfrontPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nREAL\n-----END PUBLIC KEY-----\n", kindleSender: "library@elsewhere.example" }));
    expect(() => loadConfig(file)).toThrow(/kindleSender must be an address on lit\.example\.com/);
  });
```

`infra/test/stack.test.ts`: add `"KindleSender"` to the outputs list.

`indexer/tests/test_write_web_env.py`: add `"KindleSender": "library@lit.example.com"` to the outputs fixture and assert `"VITE_KINDLE_SENDER=library@lit.example.com" in dev and "VITE_KINDLE_SENDER=library@lit.example.com" in prod`.

`web/src/config.test.ts` — extend the existing missing-key test so `VITE_KINDLE_SENDER` is required, and add an assertion that `readConfig({...valid, VITE_KINDLE_SENDER: "library@lit.example.com"}).kindleSender === "library@lit.example.com"`.

Because `AppConfig` gains a required field, add `kindleSender: "library@lit.example.com"` to every `AppConfig` fixture in the web tests (`web/src/auth/AuthProvider.test.tsx` `cfg`, `web/src/App.test.tsx` `cfg`, and any in `config.test.ts`) so typecheck stays green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/config.test.ts test/stack.test.ts; cd ../indexer && .venv/bin/pytest -q tests/test_write_web_env.py; cd ../web && npx vitest run src/config.test.ts`
Expected: FAIL in each.

- [ ] **Step 3: Implement**

`infra/lib/config.ts`: add `kindleSender: string;` to the interface and `"kindleSender"` to `KEYS`; after the missing-keys check add:

```ts
  const senderDomain = String(raw.kindleSender).split("@")[1] ?? "";
  if (senderDomain.toLowerCase() !== String(raw.siteDomain).toLowerCase()) {
    throw new Error(`kindleSender must be an address on ${raw.siteDomain} (SES sends only as the verified site domain)`);
  }
```

`infra/config.example.json`: add `"kindleSender": "library@lit.example.com"`. Also add `"kindleSender": "library@lit.davidjdrake.com"` to the gitignored `infra/config.local.json` on this machine (not committed).

`infra/lib/ebook-share-stack.ts`: `new CfnOutput(this, "KindleSender", { value: config.kindleSender });`

`scripts/write-web-env.py`: in `render`, append `f"VITE_KINDLE_SENDER={outputs['KindleSender']}"` after the `VITE_API_URL` line.

`web/vite.config.ts`: add `"VITE_KINDLE_SENDER"` to `REQUIRED_ENV_KEYS`. `web/src/config.ts`: add `kindleSender: string` to `AppConfig`, `kindleSender: "VITE_KINDLE_SENDER"` to `KEYS`, and `kindleSender: env[KEYS.kindleSender]!` to the returned object. `web/src/test/setup.ts`: add `(import.meta.env as Record<string, string>).VITE_KINDLE_SENDER ??= "library@lit.example.com";`. `.github/workflows/ci.yml`: add `VITE_KINDLE_SENDER: library@example.com` to the web job's `env`. Until Task 12 regenerates them, append `VITE_KINDLE_SENDER=library@lit.davidjdrake.com` to both gitignored `web/.env.*.local` files by hand so `npm run build` keeps working.

- [ ] **Step 4: Run all three suites**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null; cd ../web && npm test && npm run typecheck && npm run build; cd ../indexer && .venv/bin/pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/config.ts infra/config.example.json infra/lib/ebook-share-stack.ts infra/test/config.test.ts infra/test/stack.test.ts scripts/write-web-env.py indexer/tests/test_write_web_env.py web/vite.config.ts web/src/config.ts web/src/config.test.ts web/src/test/setup.ts .github/workflows/ci.yml
git commit -m "feat(config): kindleSender setting, KindleSender output, VITE_KINDLE_SENDER"
```

---

### Task 3: Kindle Lambda pure helpers

**Files:**
- Create: `infra/lambda/kindle/lib.ts`
- Modify: `infra/package.json` (add `"@aws-sdk/client-sesv2": "^3.700.0"` and `"@aws-sdk/client-sns": "^3.700.0"`; `npm install`; commit the lockfile)
- Test: `infra/test/kindle-lib.test.ts`

**Interfaces:**
- Consumes: `CatalogBook`, `CatalogFormat` from `../download/download`.
- Produces:

```ts
export const KINDLE_MAX_BYTES = 28 * 1024 * 1024;
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export function parseKindleAddress(raw: unknown): string | null | undefined  // "" → null (clear); valid → lowercased; else undefined
export function chooseFormat(book: CatalogBook, requested?: string): CatalogFormat | undefined  // requested (epub|pdf) if present, else epub, else pdf
export const CONTENT_TYPES: Record<"epub" | "pdf", string>  // application/epub+zip, application/pdf
export interface MimeInput { from: string; to: string; subject: string; filename: string; contentType: string; body: Uint8Array; date?: Date }
export function buildMime(m: MimeInput): string   // multipart/mixed, text part + one base64 attachment, CRLF line endings, base64 wrapped at 76 chars
export function classifySesError(e: unknown): "not_enabled" | "failed"   // name MessageRejected + /not verified/i → not_enabled
```

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/kindle-lib.test.ts
import { describe, expect, it } from "vitest";
import type { CatalogBook } from "../lambda/download/download";
import { buildMime, chooseFormat, classifySesError, CONTENT_TYPES, KINDLE_MAX_BYTES, parseKindleAddress } from "../lambda/kindle/lib";

const book: CatalogBook = { id: "b1", title: "Attacking Network Protocols", formats: [
  { type: "pdf", size: 10, s3Key: "books/x.pdf" }, { type: "epub", size: 20, s3Key: "books/x.epub" }, { type: "cbz", size: 5, s3Key: "books/x.cbz" },
] };

describe("parseKindleAddress", () => {
  it("accepts and lowercases kindle.com addresses; empty clears; others are invalid", () => {
    expect(parseKindleAddress("Jay_ABC@Kindle.com")).toBe("jay_abc@kindle.com");
    expect(parseKindleAddress("")).toBeNull();
    expect(parseKindleAddress("jay@gmail.com")).toBeUndefined();
    expect(parseKindleAddress("jay@kindle.com.evil")).toBeUndefined();
    expect(parseKindleAddress(42)).toBeUndefined();
  });
});

describe("chooseFormat", () => {
  it("prefers epub, then pdf, honours an explicit request, and ignores unsupported types", () => {
    expect(chooseFormat(book)?.type).toBe("epub");
    expect(chooseFormat(book, "pdf")?.type).toBe("pdf");
    expect(chooseFormat(book, "cbz")).toBeUndefined();
    expect(chooseFormat({ ...book, formats: [book.formats[0]] })?.type).toBe("pdf");
    expect(chooseFormat({ ...book, formats: [book.formats[2]] })).toBeUndefined();
    expect(KINDLE_MAX_BYTES).toBe(28 * 1024 * 1024);
    expect(CONTENT_TYPES.epub).toBe("application/epub+zip");
  });
});

describe("buildMime", () => {
  it("builds a multipart message with one base64 attachment and CRLF endings", () => {
    const body = new TextEncoder().encode("PKhello");
    const raw = buildMime({ from: "library@lit.example.com", to: "jay@kindle.com", subject: "Attacking Network Protocols", filename: "Attacking Network Protocols.epub", contentType: "application/epub+zip", body, date: new Date("2026-09-05T10:00:00.000Z") });
    expect(raw.startsWith("From: library@lit.example.com\r\n")).toBe(true);
    expect(raw).toContain("To: jay@kindle.com\r\n");
    expect(raw).toContain("Subject: Attacking Network Protocols\r\n");
    expect(raw).toContain("MIME-Version: 1.0\r\n");
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"\r\n/);
    expect(raw).toContain('Content-Type: application/epub+zip; name="Attacking Network Protocols.epub"\r\n');
    expect(raw).toContain('Content-Disposition: attachment; filename="Attacking Network Protocols.epub"\r\n');
    expect(raw).toContain("Content-Transfer-Encoding: base64\r\n");
    expect(raw).toContain(Buffer.from(body).toString("base64"));
    expect(raw.replace(/\r\n/g, "").includes("\n")).toBe(false); // CRLF only
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });
  it("wraps long base64 at 76 columns and strips quotes from the filename", () => {
    const raw = buildMime({ from: "a@x.example", to: "b@kindle.com", subject: "S", filename: 'Say "Hi".pdf', contentType: "application/pdf", body: new Uint8Array(200), date: new Date(0) });
    const b64Lines = raw.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]{60,}$/.test(l));
    expect(b64Lines.length).toBeGreaterThan(1);
    expect(b64Lines.every((l) => l.length <= 76)).toBe(true);
    expect(raw).toContain('filename="Say Hi.pdf"');
  });
});

describe("classifySesError", () => {
  it("maps the sandbox 'not verified' rejection to not_enabled", () => {
    expect(classifySesError(Object.assign(new Error("Email address is not verified. The following identities failed"), { name: "MessageRejected" }))).toBe("not_enabled");
    expect(classifySesError(Object.assign(new Error("Daily sending quota exceeded"), { name: "MessageRejected" }))).toBe("failed");
    expect(classifySesError(new Error("network"))).toBe("failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npm install --save @aws-sdk/client-sesv2@^3.700.0 @aws-sdk/client-sns@^3.700.0 && npx vitest run test/kindle-lib.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// infra/lambda/kindle/lib.ts
import type { CatalogBook, CatalogFormat } from "../download/download";

export const KINDLE_MAX_BYTES = 28 * 1024 * 1024; // SES raw limit is 40 MB; base64 adds ~37%
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export const CONTENT_TYPES: Record<"epub" | "pdf", string> = { epub: "application/epub+zip", pdf: "application/pdf" };
const ORDER: Array<"epub" | "pdf"> = ["epub", "pdf"];

/** "" → null (clear the setting); a valid address → lowercased; anything else → undefined. */
export function parseKindleAddress(raw: unknown): string | null | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s === "") return null;
  return KINDLE_ADDRESS_RE.test(s) ? s.toLowerCase() : undefined;
}

export function chooseFormat(book: CatalogBook, requested?: string): CatalogFormat | undefined {
  if (requested !== undefined) {
    return ORDER.includes(requested as "epub" | "pdf") ? book.formats.find((f) => f.type === requested) : undefined;
  }
  for (const t of ORDER) {
    const f = book.formats.find((x) => x.type === t);
    if (f) return f;
  }
  return undefined;
}

export interface MimeInput { from: string; to: string; subject: string; filename: string; contentType: string; body: Uint8Array; date?: Date }

function wrap76(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join("\r\n");
}
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/"/g, "");

export function buildMime(m: MimeInput): string {
  const date = m.date ?? new Date();
  const boundary = `----=_lit_${date.getTime().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const filename = headerSafe(m.filename);
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${headerSafe(m.subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "Sent from your private library.",
    "",
    `--${boundary}`,
    `Content-Type: ${m.contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.body).toString("base64")),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

export function classifySesError(e: unknown): "not_enabled" | "failed" {
  const err = e as { name?: string; message?: string };
  return err?.name === "MessageRejected" && /not verified/i.test(err.message ?? "") ? "not_enabled" : "failed";
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd infra && npx vitest run test/kindle-lib.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/lib.ts infra/test/kindle-lib.test.ts infra/package.json infra/package-lock.json
git commit -m "feat(kindle): address parsing, format choice, MIME builder"
```

---

### Task 4: Kindle Lambda handler against injected deps

**Files:**
- Create: `infra/lambda/kindle/index.ts`
- Test: `infra/test/kindle-handler.test.ts`

**Interfaces:**
- Consumes: `parseKindleAddress`, `chooseFormat`, `buildMime`, `classifySesError`, `CONTENT_TYPES`, `KINDLE_MAX_BYTES` (`./lib`); `Catalog`, `downloadFilename` (`../download/download`); `DownloadLog` (`../download/index`); `logEvent` (`../shared/log`).
- Produces (all exported from `index.ts`):

```ts
export interface KindleStore {
  getAddress(email: string): Promise<string | null>;
  setAddress(email: string, address: string | null, updatedAt: string): Promise<void>;  // null deletes the row
}
export interface Sender { send(raw: string, tags: Record<string, string>): Promise<{ messageId: string }> }
export interface Deps {
  store: KindleStore; loadCatalog: () => Promise<Catalog>; loadObject: (s3Key: string) => Promise<Uint8Array>;
  sender: Sender; logSend: (row: DownloadLog) => Promise<void>; now: () => Date; senderAddress: string;
}
export function tagValue(email: string): string          // hex encoding — SES tag values allow only [A-Za-z0-9_-]
export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2>
```

  Routes: `GET /api/kindle/address`, `PUT /api/kindle/address`, `POST /api/kindle/send`. SES tags are `recipient=<tagValue(email)>` and `bookId=<id>`. Production `handler` comes in Task 5.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/kindle-handler.test.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { Catalog } from "../lambda/download/download";
import { handle, tagValue, type Deps, type KindleStore } from "../lambda/kindle/index";
import { KINDLE_MAX_BYTES } from "../lambda/kindle/lib";

const NOW = "2026-09-05T12:00:00.000Z";
const catalog: Catalog = { books: [
  { id: "b1", title: "Attacking Network Protocols", formats: [{ type: "epub", size: 1000, s3Key: "books/a.epub" }, { type: "pdf", size: 2000, s3Key: "books/a.pdf" }] },
  { id: "big", title: "Huge Atlas", formats: [{ type: "pdf", size: KINDLE_MAX_BYTES + 1, s3Key: "books/big.pdf" }] },
  { id: "cbz", title: "Comic", formats: [{ type: "cbz", size: 10, s3Key: "books/c.cbz" }] },
] };

function store(address: string | null = "jay_abc@kindle.com"): KindleStore {
  return { getAddress: vi.fn().mockResolvedValue(address), setAddress: vi.fn().mockResolvedValue(undefined) };
}
function deps(over: Partial<Deps> = {}): Deps {
  return {
    store: store(), loadCatalog: vi.fn().mockResolvedValue(catalog),
    loadObject: vi.fn().mockResolvedValue(new TextEncoder().encode("PKdata")),
    sender: { send: vi.fn().mockResolvedValue({ messageId: "ses-1" }) },
    logSend: vi.fn().mockResolvedValue(undefined), now: () => new Date(NOW), senderAddress: "library@lit.example.com",
    ...over,
  };
}
function ev(method: string, path: string, body?: unknown, email: string | undefined = "Jay@Example.com") {
  return {
    rawPath: path, body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: email ? { email } : {}, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const parse = (r: Awaited<ReturnType<typeof handle>>) => { const x = r as { statusCode: number; body?: string }; return { status: x.statusCode, json: x.body ? JSON.parse(x.body) : undefined }; };

describe("address", () => {
  it("GET returns the saved address or null, keyed by the lowercased email", async () => {
    const d = deps();
    expect(parse(await handle(ev("GET", "/api/kindle/address"), d))).toEqual({ status: 200, json: { kindleAddress: "jay_abc@kindle.com" } });
    expect(d.store.getAddress).toHaveBeenCalledWith("jay@example.com");
    expect(parse(await handle(ev("GET", "/api/kindle/address"), deps({ store: store(null) }))).json).toEqual({ kindleAddress: null });
  });
  it("PUT validates, lowercases, clears on empty, 400s otherwise", async () => {
    const d = deps();
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "Jay_ABC@Kindle.com" }), d)).status).toBe(204);
    expect(d.store.setAddress).toHaveBeenCalledWith("jay@example.com", "jay_abc@kindle.com", NOW);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "" }), d)).status).toBe(204);
    expect(d.store.setAddress).toHaveBeenLastCalledWith("jay@example.com", null, NOW);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", { kindleAddress: "jay@gmail.com" }), d)).status).toBe(400);
    expect(parse(await handle(ev("PUT", "/api/kindle/address", {}), d)).status).toBe(400);
  });
});

describe("send", () => {
  it("sends the EPUB by default with the right MIME, tags, log row, and 202", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { status, json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), d));
    expect(status).toBe(202);
    expect(json).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(d.loadObject).toHaveBeenCalledWith("books/a.epub");
    const [raw, tags] = (d.sender.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(raw).toContain("To: jay_abc@kindle.com\r\n");
    expect(raw).toContain("From: library@lit.example.com\r\n");
    expect(raw).toContain("Subject: Attacking Network Protocols\r\n");
    expect(raw).toContain('filename="Attacking Network Protocols.epub"');
    expect(tags).toEqual({ recipient: tagValue("jay@example.com"), bookId: "b1" });
    expect(d.logSend).toHaveBeenCalledWith({ email: "jay@example.com", sk: `${NOW}#b1`, bookId: "b1", format: "kindle:epub", title: "Attacking Network Protocols", timestamp: NOW });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.sent", email: "jay@example.com", bookId: "b1", format: "epub", bytes: 6, sesMessageId: "ses-1" }));
    log.mockRestore();
  });
  it("honours an explicit pdf request", async () => {
    const d = deps();
    const { json } = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1", format: "pdf" }), d));
    expect(json.format).toBe("pdf");
    expect(d.loadObject).toHaveBeenCalledWith("books/a.pdf");
  });
  it("409 no_address, 404 unknown, 400 unsupported, 413 too_large (before reading S3)", async () => {
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store: store(null) }))).json).toEqual({ error: "no_address" });
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "zz" }), deps())).status).toBe(404);
    expect(parse(await handle(ev("POST", "/api/kindle/send", { bookId: "cbz" }), deps())).json).toEqual({ error: "unsupported" });
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "big" }), d));
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "too_large", bytes: KINDLE_MAX_BYTES + 1, limit: KINDLE_MAX_BYTES });
    expect(d.loadObject).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.oversize", bookId: "big" }));
    log.mockRestore();
    expect(parse(await handle(ev("POST", "/api/kindle/send", {}), deps())).status).toBe(400);
  });
  it("maps the sandbox rejection to 502 not_enabled and other failures to 502 failed, logging send_failed and no log row", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sandbox = deps({ sender: { send: vi.fn().mockRejectedValue(Object.assign(new Error("Email address is not verified."), { name: "MessageRejected" })) } });
    const r = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), sandbox));
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" });
    expect(sandbox.logSend).not.toHaveBeenCalled();
    const broken = deps({ sender: { send: vi.fn().mockRejectedValue(new Error("SES down")) } });
    const r2 = parse(await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), broken));
    expect(r2.status).toBe(502);
    expect(r2.json).toEqual({ error: "failed", message: "SES down" });
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((e) => e.event === "kindle.send_failed")).toHaveLength(2);
    log.mockRestore(); spy.mockRestore();
  });
  it("401 without email, 404 on unknown routes, 500 on unexpected errors", async () => {
    expect(parse(await handle(ev("GET", "/api/kindle/address", undefined, undefined), deps())).status).toBe(401);
    expect(parse(await handle(ev("DELETE", "/api/kindle/address"), deps())).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parse(await handle(ev("GET", "/api/kindle/address"), deps({ store: { getAddress: vi.fn().mockRejectedValue(new Error("boom")), setAddress: vi.fn() } }))).status).toBe(500);
    spy.mockRestore();
  });
});

describe("tagValue", () => {
  it("hex-encodes so the value fits SES's [A-Za-z0-9_-] tag charset", () => {
    expect(tagValue("jay@example.com")).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(tagValue("jay@example.com"), "hex").toString()).toBe("jay@example.com");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-handler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the handler**

```ts
// infra/lambda/kindle/index.ts
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { downloadFilename, type Catalog } from "../download/download";
import type { DownloadLog } from "../download/index";
import { logEvent } from "../shared/log";
import { buildMime, chooseFormat, classifySesError, CONTENT_TYPES, KINDLE_MAX_BYTES, parseKindleAddress } from "./lib";

export interface KindleStore {
  getAddress(email: string): Promise<string | null>;
  /** null deletes the settings row. */
  setAddress(email: string, address: string | null, updatedAt: string): Promise<void>;
}
export interface Sender { send(raw: string, tags: Record<string, string>): Promise<{ messageId: string }> }
export interface Deps {
  store: KindleStore;
  loadCatalog: () => Promise<Catalog>;
  loadObject: (s3Key: string) => Promise<Uint8Array>;
  sender: Sender;
  logSend: (row: DownloadLog) => Promise<void>;
  now: () => Date;
  senderAddress: string;
}

export const NOT_ENABLED_MESSAGE = "Kindle delivery isn't enabled for everyone yet";

// SES email-tag values allow only [A-Za-z0-9_-]; an email address does not fit, so hex-encode it.
export const tagValue = (email: string): string => Buffer.from(email, "utf8").toString("hex");

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try { const v: unknown = JSON.parse(body); return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function sendBook(email: string, body: Record<string, unknown>, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const bookId = body.bookId;
  if (typeof bookId !== "string" || !bookId) return json(400, { error: "bad_request", message: "Body must be JSON {bookId, format?}" });
  const requested = typeof body.format === "string" ? body.format.toLowerCase() : undefined;

  const address = await deps.store.getAddress(email);
  if (!address) return json(409, { error: "no_address" });

  const catalog = await deps.loadCatalog();
  const book = catalog.books.find((b) => b.id === bookId);
  if (!book) return json(404, { error: "unknown_book" });
  const format = chooseFormat(book, requested);
  if (!format) return json(400, { error: "unsupported", message: "Only EPUB and PDF can be sent to a Kindle" });
  if (format.size > KINDLE_MAX_BYTES) {
    logEvent("kindle.oversize", { email, bookId, format: format.type, bytes: format.size }, deps.now);
    return json(413, { error: "too_large", bytes: format.size, limit: KINDLE_MAX_BYTES });
  }

  const bytes = await deps.loadObject(format.s3Key);
  if (bytes.byteLength > KINDLE_MAX_BYTES) {
    logEvent("kindle.oversize", { email, bookId, format: format.type, bytes: bytes.byteLength }, deps.now);
    return json(413, { error: "too_large", bytes: bytes.byteLength, limit: KINDLE_MAX_BYTES });
  }
  const type = format.type as "epub" | "pdf";
  const raw = buildMime({
    from: deps.senderAddress, to: address, subject: book.title,
    filename: downloadFilename(book.title, type, book.id), contentType: CONTENT_TYPES[type], body: bytes, date: deps.now(),
  });
  let messageId: string;
  try {
    ({ messageId } = await deps.sender.send(raw, { recipient: tagValue(email), bookId }));
  } catch (e) {
    const code = classifySesError(e);
    console.error("kindle send failed:", e);
    logEvent("kindle.send_failed", { email, bookId, format: type, code, reason: (e as Error).message }, deps.now);
    return json(502, { error: code, message: code === "not_enabled" ? NOT_ENABLED_MESSAGE : (e as Error).message });
  }
  const timestamp = deps.now().toISOString();
  await deps.logSend({ email, sk: `${timestamp}#${bookId}`, bookId, format: `kindle:${type}`, title: book.title, timestamp });
  logEvent("kindle.sent", { email, bookId, format: type, bytes: bytes.byteLength, sesMessageId: messageId }, deps.now);
  return json(202, { sentTo: address, format: type });
}

export async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer, deps: Deps): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const email = String(claims.email ?? "").toLowerCase();
  if (!email) return json(401, { error: "unauthorized", message: "Token has no email claim (send the ID token)" });
  try {
    if (method === "GET" && path === "/api/kindle/address") {
      return json(200, { kindleAddress: await deps.store.getAddress(email) });
    }
    if (method === "PUT" && path === "/api/kindle/address") {
      const parsed = parseKindleAddress(parseBody(event.body).kindleAddress);
      if (parsed === undefined) return json(400, { error: "bad_address", message: "Enter your @kindle.com address" });
      await deps.store.setAddress(email, parsed, deps.now().toISOString());
      return { statusCode: 204 };
    }
    if (method === "POST" && path === "/api/kindle/send") {
      return await sendBook(email, parseBody(event.body), deps);
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    console.error("kindle handler failed:", e);
    return json(500, { error: "internal", message: "Internal error" });
  }
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd infra && npx vitest run test/kindle-handler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/index.ts infra/test/kindle-handler.test.ts
git commit -m "feat(kindle): address and send handler"
```

---

### Task 5: Kindle settings store and production wiring

**Files:**
- Create: `infra/lambda/kindle/store.ts`
- Modify: `infra/lambda/kindle/index.ts` (append production wiring)
- Test: `infra/test/kindle-store.test.ts`

**Interfaces:**
- Produces: `class DynamoKindleStore implements KindleStore` with `constructor(ddb: DynamoDBDocumentClient, table: string)`; `export const handler` reading `KINDLE_SENDER`, `KINDLE_CONFIG_SET`, `BOOKS_BUCKET`, `SITE_BUCKET`, `LIBRARY_TABLE`, `DOWNLOADS_TABLE`.

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/kindle-store.test.ts
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoKindleStore } from "../lambda/kindle/store";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}

describe("DynamoKindleStore", () => {
  it("reads the caller's SETTINGS row", async () => {
    const { ddb, send } = client(() => ({ Item: { pk: "USER#jay@example.com", sk: "SETTINGS", kindleAddress: "jay_abc@kindle.com" } }));
    expect(await new DynamoKindleStore(ddb, "T").getAddress("jay@example.com")).toBe("jay_abc@kindle.com");
    const cmd = send.mock.calls[0][0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
    const none = client(() => ({}));
    expect(await new DynamoKindleStore(none.ddb, "T").getAddress("jay@example.com")).toBeNull();
  });
  it("writes the row on set and deletes it on null", async () => {
    const { ddb, send } = client(() => ({}));
    const store = new DynamoKindleStore(ddb, "T");
    await store.setAddress("jay@example.com", "jay_abc@kindle.com", "2026-09-05T12:00:00.000Z");
    const put = send.mock.calls[0][0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input).toEqual({ TableName: "T", Item: { pk: "USER#jay@example.com", sk: "SETTINGS", kindleAddress: "jay_abc@kindle.com", updatedAt: "2026-09-05T12:00:00.000Z" } });
    await store.setAddress("jay@example.com", null, "2026-09-05T12:00:00.000Z");
    const del = send.mock.calls[1][0] as DeleteCommand;
    expect(del).toBeInstanceOf(DeleteCommand);
    expect(del.input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// infra/lambda/kindle/store.ts
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { KindleStore } from "./index";

const SK = "SETTINGS";
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

// Per-user settings live in the library table next to the overlay rows; only the
// caller's own pk is ever touched.
export class DynamoKindleStore implements KindleStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async getAddress(email: string): Promise<string | null> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
    const v = out.Item?.kindleAddress;
    return typeof v === "string" && v ? v : null;
  }

  async setAddress(email: string, address: string | null, updatedAt: string): Promise<void> {
    if (address === null) {
      await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
      return;
    }
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { pk: pkOf(email), sk: SK, kindleAddress: address, updatedAt } }));
  }
}
```

Append to `infra/lambda/kindle/index.ts`:

```ts
// ---- production wiring (never exercised by tests) ----
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoKindleStore } from "./store";

const CATALOG_TTL_MS = 60_000;
let productionDeps: Deps | undefined;
let catalogCache: { catalog: Catalog; at: number } | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  if (!productionDeps) {
    const s3 = new S3Client({});
    const ses = new SESv2Client({ maxAttempts: 2 });
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const env = (k: string) => process.env[k] ?? "";
    productionDeps = {
      store: new DynamoKindleStore(ddb, env("LIBRARY_TABLE")),
      loadCatalog: async () => {
        if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
        const out = await s3.send(new GetObjectCommand({ Bucket: env("SITE_BUCKET"), Key: "catalog.json" }));
        const catalog = JSON.parse(await out.Body!.transformToString()) as Catalog;
        catalogCache = { catalog, at: Date.now() };
        return catalog;
      },
      loadObject: async (key) => {
        const out = await s3.send(new GetObjectCommand({ Bucket: env("BOOKS_BUCKET"), Key: key }));
        return out.Body!.transformToByteArray();
      },
      sender: {
        send: async (raw, tags) => {
          const out = await ses.send(new SendEmailCommand({
            FromEmailAddress: env("KINDLE_SENDER"),
            Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
            ConfigurationSetName: env("KINDLE_CONFIG_SET"),
            EmailTags: Object.entries(tags).map(([Name, Value]) => ({ Name, Value })),
          }));
          return { messageId: out.MessageId ?? "" };
        },
      },
      logSend: async (row) => { await ddb.send(new PutCommand({ TableName: env("DOWNLOADS_TABLE"), Item: row })); },
      now: () => new Date(),
      senderAddress: env("KINDLE_SENDER"),
    };
  }
  return handle(event, productionDeps);
};
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd infra && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/store.ts infra/lambda/kindle/index.ts infra/test/kindle-store.test.ts
git commit -m "feat(kindle): settings store and production wiring (S3, SES v2)"
```

---

### Task 6: `kindle-events` Lambda (bounces → notification, log, alert)

**Files:**
- Modify: `infra/lambda/notifications/fanout.ts` (add `"kindle_bounce"` to `NotificationType`; optional id override)
- Create: `infra/lambda/kindle-events/index.ts`
- Test: `infra/test/notifications-fanout.test.ts` (id override), `infra/test/kindle-events.test.ts`

**Interfaces:**
- Consumes: `notify`, `NotifyDeps`, `CognitoDirectory`, `DynamoNotificationWriter` (`../notifications/fanout`); `logEvent`; `tagValue` decoding (hex).
- Produces:
  - fanout: `NotificationType` gains `"kindle_bounce"`; `buildRows(type, payload, emails, now, newId, id?: string)` uses `id` for the `sk` suffix when given; `notify(type, payload, recipients, deps, opts?: { id?: string })`; `NotifyFn` gains the optional 4th parameter `opts?: { id?: string }`.
  - kindle-events: `export interface Deps { notify: NotifyFn; alert: (subject: string, message: string) => Promise<void>; now: () => Date }`, `export async function handle(event: SNSEvent, deps: Deps): Promise<{ processed: number; ignored: number }>`, `export const handler`. Env: `NOTIFICATIONS_TABLE`, `USER_POOL_ID`, `ALERTS_TOPIC_ARN`.
  - Reason strings: Bounce → `${bounceType}/${bounceSubType}` plus the first `diagnosticCode` if present; Complaint → `complaint:${complaintFeedbackType ?? "unknown"}`; Reject → `reject:${reason}`.

- [ ] **Step 1: Write the failing tests**

Add to `infra/test/notifications-fanout.test.ts`:

```ts
  it("uses an explicit id for the sk when given (idempotent redelivery)", () => {
    const rows = buildRows("kindle_bounce", { bookId: "b" }, ["x@example.com"], NOW, () => "random", "ses-msg-1");
    expect(rows[0].sk).toBe("2026-09-05T10:00:00.000Z#ses-msg-1");
  });
```

and, in the `notify` describe: `expect(await notify("kindle_bounce", { bookId: "b" }, ["a@example.com"], d, { id: "ses-1" })).toBe(1); expect(d.written.at(-1)!.sk.endsWith("#ses-1")).toBe(true);`

```ts
// infra/test/kindle-events.test.ts
import type { SNSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handle, type Deps } from "../lambda/kindle-events/index";

const NOW = "2026-09-05T12:00:00.000Z";
const hex = (s: string) => Buffer.from(s).toString("hex");
function sns(...messages: unknown[]): SNSEvent {
  return { Records: messages.map((m) => ({ Sns: { Message: JSON.stringify(m) } })) } as unknown as SNSEvent;
}
const bounce = {
  eventType: "Bounce",
  mail: { messageId: "ses-1", tags: { recipient: [hex("jay@example.com")], bookId: ["b1"] }, destination: ["jay_abc@kindle.com"] },
  bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "jay_abc@kindle.com", diagnosticCode: "smtp; 550 sender not approved" }] },
};
function deps(): Deps & { notify: ReturnType<typeof vi.fn>; alert: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn().mockResolvedValue(1), alert: vi.fn().mockResolvedValue(undefined), now: () => new Date(NOW) };
}

describe("kindle-events", () => {
  it("turns a bounce into a notification keyed by the SES message id, a log event, and an alert", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await handle(sns(bounce), d)).toEqual({ processed: 1, ignored: 0 });
    expect(d.notify).toHaveBeenCalledWith("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "Permanent/General: smtp; 550 sender not approved" }, ["jay@example.com"], { id: "ses-1" });
    expect(d.alert).toHaveBeenCalledWith("Kindle delivery Bounce: jay", expect.stringContaining("b1"));
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(expect.objectContaining({ event: "kindle.bounce", recipient: "jay@example.com", bookId: "b1", kind: "Bounce", sesMessageId: "ses-1" }));
    log.mockRestore();
  });
  it("handles complaints and rejects, and ignores other or untagged events", async () => {
    const d = deps();
    const complaint = { eventType: "Complaint", mail: bounce.mail, complaint: { complaintFeedbackType: "abuse" } };
    const reject = { eventType: "Reject", mail: { ...bounce.mail, messageId: "ses-2" }, reject: { reason: "Bad content" } };
    const delivery = { eventType: "Delivery", mail: bounce.mail };
    const untagged = { eventType: "Bounce", mail: { messageId: "ses-3", tags: {} }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [] } };
    expect(await handle(sns(complaint, reject, delivery, untagged), d)).toEqual({ processed: 2, ignored: 2 });
    expect(d.notify).toHaveBeenNthCalledWith(1, "kindle_bounce", { bookId: "b1", kind: "Complaint", reason: "complaint:abuse" }, ["jay@example.com"], { id: "ses-1" });
    expect(d.notify).toHaveBeenNthCalledWith(2, "kindle_bounce", { bookId: "b1", kind: "Reject", reason: "reject:Bad content" }, ["jay@example.com"], { id: "ses-2" });
  });
  it("keeps going when one record fails and reports it", async () => {
    const d = deps();
    d.notify.mockRejectedValueOnce(new Error("ddb down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handle(sns(bounce, { ...bounce, mail: { ...bounce.mail, messageId: "ses-9" } }), d)).toEqual({ processed: 1, ignored: 1 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/notifications-fanout.test.ts test/kindle-events.test.ts`
Expected: FAIL — `buildRows` ignores the 6th argument; module missing.

- [ ] **Step 3: Implement**

`fanout.ts` changes: `export type NotificationType = "suggestion_pending" | "suggestion_resolved" | "books_added" | "category_created" | "kindle_bounce";` `buildRows(type, payload, emails, now, newId, id?: string)` → `sk: \`${createdAt}#${id ?? newId()}\``; `notify(type, payload, recipients, deps, opts: { id?: string } = {})` passes `opts.id`; `NotifyFn = (type, payload, recipients, opts?: { id?: string }) => Promise<number>`. Existing callers are unaffected. The production wirings in `library/index.ts` and `notifications/index.ts` must forward the 4th parameter: `notify: (type, payload, recipients, opts) => notify(type, payload, recipients, notifyDeps, opts)`.

```ts
// infra/lambda/kindle-events/index.ts
import type { SNSEvent } from "aws-lambda";
import type { NotifyFn } from "../notifications/fanout";
import { logEvent } from "../shared/log";

export interface Deps { notify: NotifyFn; alert: (subject: string, message: string) => Promise<void>; now: () => Date }

const KINDS = new Set(["Bounce", "Complaint", "Reject"]);

interface SesEvent {
  eventType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]>; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: Array<{ diagnosticCode?: string }> };
  complaint?: { complaintFeedbackType?: string };
  reject?: { reason?: string };
}

function reasonOf(ev: SesEvent): string {
  switch (ev.eventType) {
    case "Bounce": {
      const diag = ev.bounce?.bouncedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode;
      return `${ev.bounce?.bounceType ?? "?"}/${ev.bounce?.bounceSubType ?? "?"}${diag ? `: ${diag}` : ""}`;
    }
    case "Complaint": return `complaint:${ev.complaint?.complaintFeedbackType ?? "unknown"}`;
    default: return `reject:${ev.reject?.reason ?? "unknown"}`;
  }
}
const localPart = (email: string) => email.split("@")[0];

export async function handle(event: SNSEvent, deps: Deps): Promise<{ processed: number; ignored: number }> {
  let processed = 0, ignored = 0;
  for (const record of event.Records ?? []) {
    let ev: SesEvent;
    try { ev = JSON.parse(record.Sns.Message) as SesEvent; } catch { ignored += 1; continue; }
    const kind = ev.eventType ?? "";
    const recipientHex = ev.mail?.tags?.recipient?.[0];
    if (!KINDS.has(kind) || !recipientHex) { ignored += 1; continue; }
    const recipient = Buffer.from(recipientHex, "hex").toString("utf8");
    const bookId = ev.mail?.tags?.bookId?.[0] ?? "";
    const sesMessageId = ev.mail?.messageId ?? "";
    const reason = reasonOf(ev);
    try {
      await deps.notify("kindle_bounce", { bookId, kind, reason }, [recipient], { id: sesMessageId });
      logEvent("kindle.bounce", { recipient, bookId, kind, reason, sesMessageId }, deps.now);
      await deps.alert(`Kindle delivery ${kind}: ${localPart(recipient)}`,
        `Kindle delivery ${kind} for ${recipient}\nBook: ${bookId}\nReason: ${reason}\nSES message id: ${sesMessageId}\nTime: ${deps.now().toISOString()}`);
      processed += 1;
    } catch (e) {
      console.error("kindle-events record failed:", sesMessageId, e);
      ignored += 1;
    }
  }
  return { processed, ignored };
}

// ---- production wiring (never exercised by tests) ----
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { CognitoDirectory, DynamoNotificationWriter, notify } from "../notifications/fanout";

let productionDeps: Deps | undefined;

export const handler = (event: SNSEvent) => {
  if (!productionDeps) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const sns = new SNSClient({});
    const notifyDeps = {
      directory: new CognitoDirectory(new CognitoIdentityProviderClient({ maxAttempts: 2 }), process.env.USER_POOL_ID ?? ""),
      writer: new DynamoNotificationWriter(ddb, process.env.NOTIFICATIONS_TABLE ?? ""),
      now: () => new Date(), newId: () => randomUUID(),
    };
    productionDeps = {
      notify: (type, payload, recipients, opts) => notify(type, payload, recipients, notifyDeps, opts),
      alert: async (Subject, Message) => { await sns.send(new PublishCommand({ TopicArn: process.env.ALERTS_TOPIC_ARN, Subject, Message })); },
      now: () => new Date(),
    };
  }
  return handle(event, productionDeps);
};
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd infra && npm test && npm run typecheck`
Expected: PASS (the web `NotificationType` union is extended in Task 11; the two are independent).

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/notifications/fanout.ts infra/lambda/library/index.ts infra/lambda/notifications/index.ts infra/lambda/kindle-events/index.ts infra/test/notifications-fanout.test.ts infra/test/kindle-events.test.ts
git commit -m "feat(kindle): bounce handler notifies the user, logs, and alerts"
```

---

### Task 7: `Kindle` CDK construct and stack wiring

**Files:**
- Create: `infra/lib/kindle.ts`
- Modify: `infra/lib/ebook-share-stack.ts`, `infra/lib/library.ts` (no change needed if `Library` already exposes `fn`; it does)
- Test: `infra/test/kindle-construct.test.ts`, `infra/test/stack.test.ts`

**Interfaces:**
- Consumes: `COGNITO_LIST_ACTIONS` (`./notifications`), `Alerts.topic` (`./alerts`), `InfraConfig`.
- Produces:

```ts
export interface KindleProps {
  config: InfraConfig; httpApi: apigw.HttpApi; userPool: cognito.IUserPool;
  booksBucket: s3.IBucket; siteBucket: s3.IBucket; libraryTable: dynamodb.ITable; downloadsTable: dynamodb.ITable;
  notificationsTable: dynamodb.ITable; alertsTopic: sns.ITopic;
}
export class Kindle extends Construct {
  readonly identity: ses.EmailIdentity; readonly configurationSet: ses.ConfigurationSet; readonly eventsTopic: sns.Topic;
  readonly fn: NodejsFunction; readonly eventsFn: NodejsFunction;
}
```

  The stack wires `Kindle` after `Alerts` and adds `kindle.fn` and `kindle.eventsFn` to the `Alerts` function list (so they get error alarms) — which means `Alerts` must be constructed **after** `Kindle`; reorder: `Kindle` before `Alerts`, and `Kindle` receives the alerts topic via a small `sns.Topic` created in the stack? No — simplest: create the alerts **topic** inside `Alerts` as today, construct `Alerts` first with the existing five functions, then `Kindle` with `alerts.topic`, then call a new method `alerts.watch(kindle.fn); alerts.watch(kindle.eventsFn)` that adds an error alarm for one more function. Add that `watch(fn: lambda.IFunction)` method to `Alerts` (refactor its loop body into it).

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/kindle-construct.test.ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";
import { Kindle } from "../lib/kindle";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  new Kindle(stack, "Kindle", {
    config, httpApi: new apigw.HttpApi(stack, "HttpApi"), userPool: new cognito.UserPool(stack, "Pool"),
    booksBucket: new s3.Bucket(stack, "Books"), siteBucket: new s3.Bucket(stack, "Site"),
    libraryTable: table("Lib"), downloadsTable: new dynamodb.Table(stack, "Dl", { partitionKey: { name: "email", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING } }),
    notificationsTable: table("Notif"), alertsTopic: new sns.Topic(stack, "Alerts"),
  });
  return Template.fromStack(stack);
}

describe("Kindle", () => {
  it("verifies the site domain with Easy DKIM records in Route 53", () => {
    const t = synth();
    t.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "lit.example.com", DkimAttributes: { SigningEnabled: true } });
    t.resourceCountIs("AWS::Route53::RecordSet", 3);
    t.hasResourceProperties("AWS::Route53::RecordSet", { Type: "CNAME", HostedZoneId: "Z0123456789EXAMPLE00" });
  });
  it("routes bounce, complaint, and reject events to an SNS topic that triggers the events Lambda", () => {
    const t = synth();
    t.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({ Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT", "REJECT"], SnsDestination: Match.anyValue() }),
    });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });
  });
  it("gives the kindle Lambda only what it needs", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60, MemorySize: 1024,
      Environment: { Variables: Match.objectLike({
        KINDLE_SENDER: "library@lit.example.com", KINDLE_CONFIG_SET: Match.anyValue(), BOOKS_BUCKET: Match.anyValue(), SITE_BUCKET: Match.anyValue(),
        LIBRARY_TABLE: Match.anyValue(), DOWNLOADS_TABLE: Match.anyValue(),
      }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: ["ses:SendEmail", "ses:SendRawEmail"], Resource: Match.arrayWith([Match.objectLike({ "Fn::Join": Match.anyValue() })]) }),
    ]) } });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: "s3:GetObject", Resource: Match.objectLike({ "Fn::Join": ["", [Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^Books"), "Arn"] }), "/*"]] }) }),
    ]) } });
    t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 90 });
    for (const key of ["GET /api/kindle/address", "PUT /api/kindle/address", "POST /api/kindle/send"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
  });
  it("gives the events Lambda notification write, Cognito list, and alerts publish", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 30,
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue(), ALERTS_TOPIC_ARN: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"] }),
      Match.objectLike({ Action: "sns:Publish", Resource: Match.objectLike({ Ref: Match.stringLikeRegexp("^Alerts") }) }),
    ]) } });
  });
});
```

(If `RetentionInDays: 90` is asserted on a `Custom::LogRetention` resource in this CDK version rather than `AWS::Logs::LogGroup`, assert `t.hasResourceProperties("Custom::LogRetention", { RetentionInDays: 90 })` instead — check `t.toJSON()` once.)

`infra/test/stack.test.ts`: authorized routes `≥ 13`; add a test that `AWS::CloudWatch::Alarm` with `MetricName: "Errors"` count is **7** (five existing + kindle + kindle-events).

`infra/test/alerts.test.ts`: add a test that `watch(fn)` adds one more Errors alarm (synth with 2 functions, call `alerts.watch(fn("C"))` before `Template.fromStack`, expect 5 alarms total).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-construct.test.ts test/stack.test.ts test/alerts.test.ts`
Expected: FAIL — module missing; counts off.

- [ ] **Step 3: Implement**

`infra/lib/alerts.ts`: extract the per-function alarm into a public method and call it from the constructor loop:

```ts
  /** Add an Errors alarm for one more function (used for constructs created after Alerts). */
  watch(fn: lambda.IFunction): void {
    const alarmId = `${fn.node.path.split("/").slice(-2).join("")}Errors`;
    const alarm = new cloudwatch.Alarm(this, alarmId, {
      alarmDescription: `${fn.functionName} reported errors`,
      metric: fn.metricErrors({ period: WINDOW, statistic: "Sum" }),
      threshold: 1, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(this.notify);
    alarm.addOkAction(this.notify);
  }
```

(store `private readonly notify: SnsAction` on the instance; keep the constructor loop calling `this.watch(fn)`.)

```ts
// infra/lib/kindle.ts
import { Duration } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SnsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import * as path from "node:path";
import type { InfraConfig } from "./config";
import { COGNITO_LIST_ACTIONS } from "./notifications";

export interface KindleProps {
  config: InfraConfig;
  httpApi: apigw.HttpApi;
  userPool: cognito.IUserPool;
  booksBucket: s3.IBucket;
  siteBucket: s3.IBucket;
  libraryTable: dynamodb.ITable;
  downloadsTable: dynamodb.ITable;
  notificationsTable: dynamodb.ITable;
  alertsTopic: sns.ITopic;
}

// Send-to-Kindle: SES identity for the site domain, a configuration set whose
// bounce/complaint/reject events reach the kindle-events Lambda, and the kindle
// Lambda that builds and sends the email. See docs/superpowers/specs/2026-09-05-send-to-kindle-design.md.
export class Kindle extends Construct {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly eventsTopic: sns.Topic;
  readonly fn: NodejsFunction;
  readonly eventsFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: KindleProps) {
    super(scope, id);
    const { config } = props;
    const external = ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-s3"]; // runtime-provided; bundle the rest

    // The sender's domain is the site domain (loadConfig enforces it); verify it with Easy DKIM.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: config.hostedZoneId, zoneName: config.hostedZoneName });
    this.identity = new ses.EmailIdentity(this, "Identity", { identity: ses.Identity.domain(config.siteDomain) });
    this.identity.dkimRecords.forEach((r, i) => {
      new route53.CnameRecord(this, `Dkim${i}`, { zone, recordName: r.name, domainName: r.value, ttl: Duration.hours(1) });
    });

    this.eventsTopic = new sns.Topic(this, "EventsTopic", { displayName: "Lit Library Kindle delivery events" });
    this.configurationSet = new ses.ConfigurationSet(this, "ConfigSet", {});
    this.configurationSet.addEventDestination("Events", {
      destination: ses.EventDestination.snsTopic(this.eventsTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT],
    });

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/kindle/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 1024, // a 28 MB file is base64-encoded in memory
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        KINDLE_SENDER: config.kindleSender,
        KINDLE_CONFIG_SET: this.configurationSet.configurationSetName,
        BOOKS_BUCKET: props.booksBucket.bucketName,
        SITE_BUCKET: props.siteBucket.bucketName,
        LIBRARY_TABLE: props.libraryTable.tableName,
        DOWNLOADS_TABLE: props.downloadsTable.tableName,
      },
      bundling: { externalModules: external },
    });
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.booksBucket.arnForObjects("*")] }));
    props.siteBucket.grantRead(this.fn, "catalog.json");
    props.libraryTable.grantReadWriteData(this.fn);
    props.downloadsTable.grant(this.fn, "dynamodb:PutItem");
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      resources: [this.identity.emailIdentityArn, this.configurationSet.configurationSetArn],
    }));

    const integration = new HttpLambdaIntegration("KindleIntegration", this.fn);
    props.httpApi.addRoutes({ path: "/api/kindle/address", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.PUT], integration });
    props.httpApi.addRoutes({ path: "/api/kindle/send", methods: [apigw.HttpMethod.POST], integration });

    this.eventsFn = new NodejsFunction(this, "EventsFn", {
      entry: path.join(__dirname, "../lambda/kindle-events/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        NOTIFICATIONS_TABLE: props.notificationsTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        ALERTS_TOPIC_ARN: props.alertsTopic.topicArn,
      },
      bundling: { externalModules: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"] },
    });
    this.eventsFn.addEventSource(new SnsEventSource(this.eventsTopic));
    props.notificationsTable.grantWriteData(this.eventsFn);
    this.eventsFn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));
    props.alertsTopic.grantPublish(this.eventsFn);
  }
}
```

Stack wiring (`ebook-share-stack.ts`), after `alerts` is created:

```ts
    const kindle = new Kindle(this, "Kindle", {
      config, httpApi: api.httpApi, userPool: auth.userPool,
      booksBucket: storage.booksBucket, siteBucket: storage.siteBucket,
      libraryTable: library.table, downloadsTable: api.table, notificationsTable: notifications.table,
      alertsTopic: alerts.topic,
    });
    alerts.watch(kindle.fn);
    alerts.watch(kindle.eventsFn);
```

(`const alerts = new Alerts(...)` — capture the instance.) `ses.Identity.domain`, `EmailIdentity.dkimRecords`, `emailIdentityArn`, `ConfigurationSet.configurationSetArn`, and `EventDestination.snsTopic` all exist in aws-cdk-lib 2.267; if `configurationSetArn` is missing, build it with `Stack.of(this).formatArn({ service: "ses", resource: "configuration-set", resourceName: this.configurationSet.configurationSetName })`.

- [ ] **Step 4: Run tests, typecheck, synth, diff**

Run: `cd infra && npm test && npm run typecheck && npx cdk synth > /dev/null && npx cdk diff 2>&1 | grep -E "^\[[+~-]\]|replace"`
Expected: PASS; diff shows only `[+]` resources plus `[~]` on the existing Lambdas' log statements if any; **no** replacements.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/kindle.ts infra/lib/alerts.ts infra/lib/ebook-share-stack.ts infra/test/kindle-construct.test.ts infra/test/alerts.test.ts infra/test/stack.test.ts
git commit -m "feat(infra): SES identity, configuration set, and the two Kindle Lambdas"
```

---

### Task 8: Web Kindle client and `KindleProvider`

**Files:**
- Create: `web/src/kindle/api.ts`, `web/src/kindle/KindleProvider.tsx`
- Modify: `web/src/auth/AuthProvider.tsx` (expose `kindleSender` from config on `AuthState`)
- Test: `web/src/kindle/api.test.ts`, `web/src/kindle/KindleProvider.test.tsx`, `web/src/auth/AuthProvider.test.tsx` (one assertion)

**Interfaces:**
- Consumes: `apiCall` (`../catalog/apiCall`).
- Produces:

```ts
// api.ts
export type KindleErrorCode = "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed";
export class KindleError extends Error { code: KindleErrorCode; details?: Record<string, unknown> }
export function getKindleAddress(apiUrl, idToken, fetchFn?): Promise<string | null>
export function saveKindleAddress(apiUrl, idToken, address: string, fetchFn?): Promise<void>   // "" clears
export function sendToKindle(apiUrl, idToken, bookId, format?: string, fetchFn?): Promise<{ sentTo: string; format: string }>
// KindleProvider.tsx
export interface KindleState { address: string | null | undefined /* undefined = loading */; sender: string; save(address: string): Promise<void>; send(bookId: string, format?: string): Promise<{ sentTo: string; format: string }> }
export function KindleProvider(props: { apiUrl; getIdToken; fetchFn?; sender: string; children }): JSX.Element
export function useKindle(): KindleState
// AuthState gains kindleSender: string (from config.kindleSender)
```

  Error mapping in `sendToKindle`: 409 → `no_address`; 413 → `too_large` (details `{bytes, limit}`); 400 with `error: "unsupported"` → `unsupported`; 502 with `error: "not_enabled"` → `not_enabled` (message from body); anything else → `failed` with the body's `message` or `error`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/kindle/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { getKindleAddress, KindleError, saveKindleAddress, sendToKindle } from "./api";

function fetchWith(status: number, body?: unknown) {
  return vi.fn(async () => ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body })) as unknown as typeof fetch;
}
const call = (f: typeof fetch) => { const m = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]; return { url: String(m[0]), init: m[1] as RequestInit }; };

describe("kindle api", () => {
  it("gets and saves the address", async () => {
    const g = fetchWith(200, { kindleAddress: "jay_abc@kindle.com" });
    expect(await getKindleAddress("/api", "tok", g)).toBe("jay_abc@kindle.com");
    expect(call(g).url).toBe("/api/kindle/address");
    const s = fetchWith(204);
    await saveKindleAddress("/api", "tok", "Jay_ABC@Kindle.com", s);
    expect(call(s).init.method).toBe("PUT");
    expect(call(s).init.body).toBe(JSON.stringify({ kindleAddress: "Jay_ABC@Kindle.com" }));
    await expect(saveKindleAddress("/api", "tok", "x@gmail.com", fetchWith(400, { error: "bad_address", message: "Enter your @kindle.com address" }))).rejects.toThrow("Enter your @kindle.com address");
  });
  it("sends and maps every error status to a KindleError code", async () => {
    const f = fetchWith(202, { sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(await sendToKindle("/api", "tok", "b1", undefined, f)).toEqual({ sentTo: "jay_abc@kindle.com", format: "epub" });
    expect(call(f).init.body).toBe(JSON.stringify({ bookId: "b1" }));
    const g = fetchWith(202, { sentTo: "x", format: "pdf" });
    await sendToKindle("/api", "tok", "b1", "pdf", g);
    expect(call(g).init.body).toBe(JSON.stringify({ bookId: "b1", format: "pdf" }));
    const cases: Array<[number, unknown, string]> = [
      [409, { error: "no_address" }, "no_address"],
      [413, { error: "too_large", bytes: 30, limit: 28 }, "too_large"],
      [400, { error: "unsupported", message: "Only EPUB and PDF" }, "unsupported"],
      [502, { error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" }, "not_enabled"],
      [502, { error: "failed", message: "SES down" }, "failed"],
      [500, { error: "internal" }, "failed"],
    ];
    for (const [status, body, code] of cases) {
      const err = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(status, body)).catch((e) => e as KindleError);
      expect(err).toBeInstanceOf(KindleError);
      expect((err as KindleError).code).toBe(code);
    }
    const big = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(413, { error: "too_large", bytes: 30, limit: 28 })).catch((e) => e as KindleError);
    expect((big as KindleError).details).toEqual({ bytes: 30, limit: 28 });
    const ne = await sendToKindle("/api", "tok", "b1", undefined, fetchWith(502, { error: "not_enabled", message: "Kindle delivery isn't enabled for everyone yet" })).catch((e) => e as KindleError);
    expect((ne as KindleError).message).toBe("Kindle delivery isn't enabled for everyone yet");
  });
});
```

```tsx
// web/src/kindle/KindleProvider.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider, useKindle } from "./KindleProvider";

function server(address: string | null) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")} ${init?.body ?? ""}`.trim());
    if (init?.method === "PUT") return { ok: true, status: 204, headers: new Headers() };
    if (init?.method === "POST") return { ok: true, status: 202, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ sentTo: "jay_abc@kindle.com", format: "epub" }) };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ kindleAddress: address }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
function Probe() {
  const k = useKindle();
  return (
    <div>
      <span data-testid="addr">{k.address === undefined ? "loading" : String(k.address)}</span>
      <span data-testid="sender">{k.sender}</span>
      <button onClick={() => void k.save("jay_abc@kindle.com")}>save</button>
      <button onClick={() => void k.send("b1")}>send</button>
    </div>
  );
}

describe("KindleProvider", () => {
  it("loads the address on mount, exposes the sender, saves, and sends", async () => {
    const { fetchFn, calls } = server(null);
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><Probe /></KindleProvider>);
    expect(screen.getByTestId("addr")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("null"));
    expect(screen.getByTestId("sender")).toHaveTextContent("library@lit.example.com");
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("jay_abc@kindle.com"));
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/kindle/send"))).toBe(true));
    expect(calls[0]).toBe("GET /api/kindle/address");
  });
  it("treats a failed initial load as no address (the API's no_address path still guards)", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({}) })) as unknown as typeof fetch;
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="s@x"><Probe /></KindleProvider>);
    await waitFor(() => expect(screen.getByTestId("addr")).toHaveTextContent("null"));
  });
});
```

`web/src/auth/AuthProvider.test.tsx`: in `Probe`, add `<span data-testid="sender">{a.kindleSender}</span>` and, in one existing signed-in test, `expect(screen.getByTestId("sender")).toHaveTextContent(cfg.kindleSender)` (add `kindleSender: "library@lit.example.com"` to the file's `cfg` fixture).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/kindle src/auth/AuthProvider.test.tsx`
Expected: FAIL — modules missing; `kindleSender` undefined.

- [ ] **Step 3: Implement**

```ts
// web/src/kindle/api.ts
import { apiCall } from "../catalog/apiCall";

export type KindleErrorCode = "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed";

export class KindleError extends Error {
  constructor(public readonly code: KindleErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KindleError";
  }
}

export async function getKindleAddress(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await apiCall(apiUrl, idToken, "/kindle/address", { method: "GET" }, 200, fetchFn);
  const body = (await res.json()) as { kindleAddress?: unknown };
  return typeof body?.kindleAddress === "string" && body.kindleAddress ? body.kindleAddress : null;
}

export async function saveKindleAddress(apiUrl: string, idToken: string, address: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiCall(apiUrl, idToken, "/kindle/address", { method: "PUT", body: JSON.stringify({ kindleAddress: address }) }, 204, fetchFn);
}

export async function sendToKindle(
  apiUrl: string, idToken: string, bookId: string, format?: string, fetchFn: typeof fetch = fetch,
): Promise<{ sentTo: string; format: string }> {
  const res = await fetchFn(`${apiUrl}/kindle/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(format ? { bookId, format } : { bookId }),
  });
  let body: { error?: string; message?: string; sentTo?: string; format?: string; bytes?: number; limit?: number } = {};
  try { body = (await res.json()) ?? {}; } catch { /* non-JSON */ }
  if (res.status === 202 && body.sentTo) return { sentTo: body.sentTo, format: body.format ?? "" };
  const message = body.message ?? body.error ?? `Send failed: ${res.status}`;
  if (res.status === 409) throw new KindleError("no_address", message);
  if (res.status === 413) throw new KindleError("too_large", message, { bytes: body.bytes, limit: body.limit });
  if (body.error === "unsupported") throw new KindleError("unsupported", message);
  if (body.error === "not_enabled") throw new KindleError("not_enabled", message);
  throw new KindleError("failed", message);
}
```

```tsx
// web/src/kindle/KindleProvider.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getKindleAddress, saveKindleAddress, sendToKindle } from "./api";

export interface KindleState {
  address: string | null | undefined; // undefined while loading
  sender: string;
  save(address: string): Promise<void>;
  send(bookId: string, format?: string): Promise<{ sentTo: string; format: string }>;
}

const Ctx = createContext<KindleState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; sender: string; children: ReactNode }

export function KindleProvider({ apiUrl, getIdToken, fetchFn = fetch, sender, children }: Props) {
  const [address, setAddress] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const a = await getKindleAddress(apiUrl, await getIdToken(), fetchFn);
        if (!cancelled) setAddress(a);
      } catch {
        if (!cancelled) setAddress(null); // the send endpoint's no_address response still guards
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  const save = useCallback(async (a: string) => {
    await saveKindleAddress(apiUrl, await getIdToken(), a, fetchFn);
    setAddress(a.trim() ? a.trim().toLowerCase() : null);
  }, [apiUrl, getIdToken, fetchFn]);

  const send = useCallback((bookId: string, format?: string) => getIdToken().then((t) => sendToKindle(apiUrl, t, bookId, format, fetchFn)),
    [apiUrl, getIdToken, fetchFn]);

  const value = useMemo<KindleState>(() => ({ address, sender, save, send }), [address, sender, save, send]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKindle(): KindleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKindle must be used inside <KindleProvider>");
  return ctx;
}
```

`AuthProvider.tsx`: add `kindleSender: string;` to `AuthState` and `kindleSender: config.kindleSender` to the memoised value (dependency `config.kindleSender`).

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/kindle/api.ts web/src/kindle/api.test.ts web/src/kindle/KindleProvider.tsx web/src/kindle/KindleProvider.test.tsx web/src/auth/AuthProvider.tsx web/src/auth/AuthProvider.test.tsx
git commit -m "feat(web): Kindle client and provider"
```

---

### Task 9: "Send to Kindle" in the book dialog

**Files:**
- Create: `web/src/components/KindleAddressForm.tsx`, `web/src/kindle/limits.ts`
- Modify: `web/src/components/BookDetail.tsx`, `web/src/components/Library.tsx`, `web/src/styles.css`
- Test: `web/src/components/KindleAddressForm.test.tsx`, `web/src/components/BookDetail.test.tsx`, `web/src/components/Library.test.tsx`

**Interfaces:**
- Consumes: `KindleState` (`../kindle/KindleProvider`), `KindleError`.
- Produces:

```ts
// web/src/kindle/limits.ts
export const KINDLE_MAX_BYTES = 28 * 1024 * 1024;
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export const KINDLE_HELP_URL = "https://www.amazon.com/hz/mycd/myx#/home/settings/payment";
export function kindleFormat(book: Book, requested?: "epub" | "pdf"): BookFormat | undefined   // requested if present, else epub, else pdf
// KindleAddressForm props
{ sender: string; initial?: string; submitLabel?: string /* default "Save and send" */; onSubmit(address: string): Promise<void>; onCancel?(): void }
// BookDetail new optional prop
kindle?: { address: string | null | undefined; sender: string; onSend(book: Book, format?: "epub" | "pdf"): Promise<void>; onSaveAddress(address: string): Promise<void> }
// Library new optional prop
kindle?: KindleState
```

  Behaviour: no `kindle` prop or no eligible format → nothing rendered. Button `Send to Kindle` (disabled + `title="Too large for Kindle delivery — download instead"` when the format that would be sent exceeds `KINDLE_MAX_BYTES`; text `Sending…` while in flight). Click with `address === null` → the inline `KindleAddressForm` replaces the button; its submit calls `onSaveAddress` then `onSend`. When both EPUB and PDF exist, a second small button `Send PDF to Kindle` (class `more`) sends the PDF. `Library` turns `KindleState` into the dialog prop, toasting `Sent to <sentTo> — it usually arrives within a couple of minutes` (ok) or the error message (fail); a failed save toasts and rethrows so the form stays open.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/KindleAddressForm.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KindleAddressForm from "./KindleAddressForm";

describe("KindleAddressForm", () => {
  it("validates client-side, submits the trimmed address, and shows the help link and sender", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<KindleAddressForm sender="library@lit.example.com" onSubmit={onSubmit} />);
    expect(screen.getByRole("link", { name: "Where do I find this?" })).toHaveAttribute("href", "https://www.amazon.com/hz/mycd/myx#/home/settings/payment");
    expect(screen.getByText(/library@lit\.example\.com/)).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Your Kindle email" });
    await userEvent.type(input, "jay@gmail.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your @kindle.com address");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "  Jay_ABC@Kindle.com ");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(onSubmit).toHaveBeenCalledWith("Jay_ABC@Kindle.com");
  });
  it("supports an initial value, a custom submit label, cancel, and stays open when onSubmit rejects", async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("nope"));
    render(<KindleAddressForm sender="s@x" initial="jay_abc@kindle.com" submitLabel="Save" onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByRole("textbox")).toHaveValue("jay_abc@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

Add to `web/src/components/BookDetail.test.tsx` (the existing `book` fixture has a 12.3 MB EPUB and a 2 MB PDF; the base props for the earlier tests are unchanged — `kindle` is optional):

```tsx
  const kindle = (address: string | null) => ({ address, sender: "library@lit.example.com", onSend: vi.fn().mockResolvedValue(undefined), onSaveAddress: vi.fn().mockResolvedValue(undefined) });
  const base = { onClose: () => {}, onDownload: async () => {}, categories: [], onChangeCategory: async () => {}, onSuggest: async () => {} };
  it("renders no Kindle button without the kindle prop or without an eligible format", () => {
    const { rerender } = render(<BookDetail book={book} {...base} />);
    expect(screen.queryByRole("button", { name: "Send to Kindle" })).toBeNull();
    rerender(<BookDetail book={{ ...book, formats: [{ type: "cbz", size: 10, s3Key: "c" }] }} {...base} kindle={kindle("jay_abc@kindle.com")} />);
    expect(screen.queryByRole("button", { name: "Send to Kindle" })).toBeNull();
  });
  it("sends the EPUB, shows Sending…, and offers the PDF as a secondary action", async () => {
    let resolve!: () => void;
    const k = kindle("jay_abc@kindle.com");
    k.onSend = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    expect(k.onSend).toHaveBeenCalledWith(book, "epub");
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send to Kindle" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Send PDF to Kindle" }));
    expect(k.onSend).toHaveBeenLastCalledWith(book, "pdf");
  });
  it("disables the button with a tooltip when the file is too large", () => {
    const huge = { ...book, formats: [{ type: "epub", size: 29 * 1024 * 1024, s3Key: "a" }] };
    render(<BookDetail book={huge} {...base} kindle={kindle("jay_abc@kindle.com")} />);
    const btn = screen.getByRole("button", { name: "Send to Kindle" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Too large for Kindle delivery — download instead");
  });
  it("collects the address inline when none is saved, then saves and sends", async () => {
    const k = kindle(null);
    render(<BookDetail book={book} {...base} kindle={k} />);
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "jay_abc@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(k.onSend).toHaveBeenCalledWith(book, "epub"));
    expect(k.onSaveAddress).toHaveBeenCalledWith("jay_abc@kindle.com");
    expect((k.onSaveAddress as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((k.onSend as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Your Kindle email" })).toBeNull());
  });
```

Add to `web/src/components/Library.test.tsx` (extend `renderLibrary` to accept a `kindle` prop and pass it through):

```tsx
  it("wires Send to Kindle to the provider and toasts the outcome", async () => {
    const kindle = { address: "jay_abc@kindle.com", sender: "library@lit.example.com", save: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue({ sentTo: "jay_abc@kindle.com", format: "epub" }) };
    renderLibrary({ apiUrl: "https://api", getIdToken: async () => "tok", fetchFn: fetchFor(catalog), kindle });
    await waitFor(() => expect(screen.getByRole("button", { name: /Attacking Network Protocols/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Attacking Network Protocols/ }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent to jay_abc@kindle.com — it usually arrives within a couple of minutes"));
    expect(kindle.send).toHaveBeenCalledWith("1", "epub");
    kindle.send.mockRejectedValueOnce(Object.assign(new Error("Kindle delivery isn't enabled for everyone yet"), { code: "not_enabled" }));
    await userEvent.click(within(screen.getByRole("dialog", { hidden: true })).getByRole("button", { name: "Send to Kindle" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Kindle delivery isn't enabled for everyone yet"));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/KindleAddressForm.test.tsx src/components/BookDetail.test.tsx src/components/Library.test.tsx`
Expected: FAIL — module missing; no Kindle button.

- [ ] **Step 3: Implement**

```ts
// web/src/kindle/limits.ts
import type { Book, BookFormat } from "../catalog/types";

export const KINDLE_MAX_BYTES = 28 * 1024 * 1024; // mirrors the Lambda's limit (SES 40 MB raw after base64)
export const KINDLE_ADDRESS_RE = /^[A-Za-z0-9._+-]+@kindle\.com$/i;
export const KINDLE_HELP_URL = "https://www.amazon.com/hz/mycd/myx#/home/settings/payment";

export function kindleFormat(book: Book, requested?: "epub" | "pdf"): BookFormat | undefined {
  if (requested) return book.formats.find((f) => f.type === requested);
  return book.formats.find((f) => f.type === "epub") ?? book.formats.find((f) => f.type === "pdf");
}
```

```tsx
// web/src/components/KindleAddressForm.tsx
import { useState, type FormEvent } from "react";
import { KINDLE_ADDRESS_RE, KINDLE_HELP_URL } from "../kindle/limits";

interface Props { sender: string; initial?: string; submitLabel?: string; onSubmit(address: string): Promise<void>; onCancel?(): void }

// Used inline in the book dialog (first send) and on the Settings page.
export default function KindleAddressForm({ sender, initial = "", submitLabel = "Save and send", onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = value.trim();
    if (address && !KINDLE_ADDRESS_RE.test(address)) { setError("Enter your @kindle.com address"); return; }
    setError(undefined); setBusy(true);
    try {
      await onSubmit(address);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kindle-form" onSubmit={(e) => void submit(e)}>
      <label>Your Kindle email
        <input type="email" value={value} disabled={busy} placeholder="name_123@kindle.com" onChange={(e) => setValue(e.target.value)} />
      </label>
      <p className="meta">
        <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Where do I find this?</a>{" "}
        Then add <code>{sender}</code> to your approved personal-document senders on that page.
      </p>
      {error && <div className="notif-error" role="alert">{error}</div>}
      <div className="suggest-form">
        <button type="submit" className="btn" disabled={busy}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
```

(`<label>Your Kindle email<input …/></label>` gives the input the accessible name "Your Kindle email".)

`BookDetail.tsx`: add the `kindle?` prop (type above), `import KindleAddressForm from "./KindleAddressForm"; import { KINDLE_MAX_BYTES, kindleFormat } from "../kindle/limits";`, state `const [kindleState, setKindleState] = useState<"idle" | "sending" | "form">("idle");` reset to `"idle"` in the book-change effect. Add after `download`:

```tsx
  async function sendToKindle(format: "epub" | "pdf") {
    if (!kindle) return;
    if (kindle.address === null) { setKindleState("form"); return; }
    setKindleState("sending");
    try { await kindle.onSend(book!, format); } finally { setKindleState("idle"); }
  }
```

and render, after the `.downloads` div:

```tsx
          {kindle && (() => {
            const primary = kindleFormat(book);
            if (!primary) return null;
            const pdf = primary.type === "epub" ? kindleFormat(book, "pdf") : undefined;
            const tooLarge = primary.size > KINDLE_MAX_BYTES;
            const sending = kindleState === "sending";
            return (
              <div className="kindle">
                {kindleState === "form" ? (
                  <KindleAddressForm sender={kindle.sender}
                    onSubmit={async (a) => { await kindle.onSaveAddress(a); setKindleState("sending"); try { await kindle.onSend(book!, primary.type as "epub" | "pdf"); } finally { setKindleState("idle"); } }}
                    onCancel={() => setKindleState("idle")} />
                ) : (
                  <>
                    <button className="btn secondary" disabled={busy || sending || tooLarge}
                      title={tooLarge ? "Too large for Kindle delivery — download instead" : undefined}
                      onClick={() => void sendToKindle(primary.type as "epub" | "pdf")}>
                      {sending ? "Sending…" : "Send to Kindle"}
                    </button>
                    {pdf && !sending && (
                      <button type="button" className="more" disabled={busy || pdf.size > KINDLE_MAX_BYTES}
                        title={pdf.size > KINDLE_MAX_BYTES ? "Too large for Kindle delivery — download instead" : undefined}
                        onClick={() => void sendToKindle("pdf")}>Send PDF to Kindle</button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
```

`Library.tsx`: add `kindle?: KindleState` to `Props` (import the type from `../kindle/KindleProvider`); build the dialog prop:

```tsx
  const kindleForDialog = useMemo(() => kindle && {
    address: kindle.address, sender: kindle.sender,
    onSend: async (book: Book, format?: "epub" | "pdf") => {
      try {
        const r = await kindle.send(book.id, format);
        ok(`Sent to ${r.sentTo} — it usually arrives within a couple of minutes`);
      } catch (e) {
        fail((e as Error).message);
      }
    },
    onSaveAddress: async (address: string) => {
      try { await kindle.save(address); } catch (e) { fail((e as Error).message); throw e; }
    },
  }, [kindle, ok, fail]);
```

and pass `kindle={kindleForDialog}` to `<BookDetail>`. `styles.css`: `.kindle { display: flex; gap: 0.6rem; align-items: center; margin-top: 0.6rem; flex-wrap: wrap; }` and `.kindle-form label { display: block; font-size: 0.9rem; }` `.kindle-form input { display: block; width: 100%; margin-top: 0.25rem; padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); }`.

- [ ] **Step 4: Run tests, typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/kindle/limits.ts web/src/components/KindleAddressForm.tsx web/src/components/KindleAddressForm.test.tsx web/src/components/BookDetail.tsx web/src/components/BookDetail.test.tsx web/src/components/Library.tsx web/src/components/Library.test.tsx web/src/styles.css
git commit -m "feat(web): Send to Kindle button with inline address capture"
```

---

### Task 10: Settings page, header link, and App wiring

**Files:**
- Create: `web/src/components/SettingsPage.tsx`
- Modify: `web/src/components/Header.tsx`, `web/src/App.tsx`, `web/src/styles.css`
- Test: `web/src/components/SettingsPage.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `useKindle`, `KindleProvider`, `KindleAddressForm`, `useRoute`, `Link`, `AuthState.kindleSender`.
- Produces: `SettingsPage` (no props; uses `useKindle()`); `Header` renders `<Link href="/settings" className="settings-link" aria-label="Settings">⚙</Link>` before the bell; `App` mounts `KindleProvider` inside `NotificationsProvider` and routes `/settings`; `Shell` passes `kindle={useKindle()}` to `Library`.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/SettingsPage.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider } from "../kindle/KindleProvider";
import SettingsPage from "./SettingsPage";

function server(address: string | null) {
  const puts: string[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { puts.push(String(init.body)); return { ok: true, status: 204, headers: new Headers() }; }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ kindleAddress: address }) };
  }) as unknown as typeof fetch;
  return { fetchFn, puts };
}
const mount = (fetchFn: typeof fetch) => render(
  <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><SettingsPage /></KindleProvider>,
);

describe("SettingsPage", () => {
  it("shows the saved address, the sender, and the checklist; saves changes", async () => {
    const { fetchFn, puts } = server("jay_abc@kindle.com");
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue("jay_abc@kindle.com"));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByText(/library@lit\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Personal Document Settings/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Your Kindle email" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "new_1@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([JSON.stringify({ kindleAddress: "new_1@kindle.com" })]));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
  it("shows the empty state while loading and for no address", async () => {
    mount(server(null).fetchFn);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your Kindle email" })).toHaveValue(""));
  });
});
```

Add to `web/src/App.test.tsx` (extend the signed-in stub so `GET /api/kindle/address` returns `{ kindleAddress: null }` and `PUT` returns 204):

```tsx
  it("links to Settings from the header and renders the page", async () => {
    render(<AuthProvider config={cfg} fetchFn={fetchFn}><App fetchFn={fetchFn} /></AuthProvider>);
    await waitFor(() => expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/settings");
  });
```

(Add `kindleSender: "library@lit.example.com"` to that file's `cfg` fixture.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/SettingsPage.test.tsx src/App.test.tsx`
Expected: FAIL — module missing; no Settings link.

- [ ] **Step 3: Implement**

```tsx
// web/src/components/SettingsPage.tsx
import { useState } from "react";
import { useKindle } from "../kindle/KindleProvider";
import { KINDLE_HELP_URL } from "../kindle/limits";
import KindleAddressForm from "./KindleAddressForm";

export default function SettingsPage() {
  const kindle = useKindle();
  const [saved, setSaved] = useState(false);

  return (
    <main className="page settings-page">
      <div className="page-head"><h2>Settings</h2></div>
      <section className="panel settings-section">
        <h3>Send to Kindle</h3>
        <p className="meta">Books you send arrive in your Kindle library as personal documents. One-time setup:</p>
        <ol className="meta">
          <li>Find your Kindle email under Amazon → Content &amp; Devices → Preferences → <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Personal Document Settings</a>.</li>
          <li>On the same page, add <code>{kindle.sender}</code> to your approved personal-document senders.</li>
        </ol>
        {kindle.address === undefined ? <p className="empty">Loading…</p> : (
          <KindleAddressForm key={kindle.address ?? ""} sender={kindle.sender} initial={kindle.address ?? ""} submitLabel="Save"
            onSubmit={async (a) => { await kindle.save(a); setSaved(true); }} />
        )}
        {saved && <p className="meta" role="status">Saved</p>}
      </section>
    </main>
  );
}
```

`Header.tsx`: inside `.header-right`, before `{bell}`, add `<Link href="/settings" className="settings-link" aria-label="Settings" title="Settings">⚙</Link>`. `styles.css`: `.settings-link { text-decoration: none; font-size: 1.1rem; color: inherit; } .settings-section h3 { margin-top: 0; } .settings-section { padding: 1rem; }`.

`App.tsx`: import `KindleProvider`, `useKindle`, `SettingsPage`. In `App`, wrap `<Shell>` with `<KindleProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn} sender={auth.kindleSender}>` inside `NotificationsProvider`. In `Shell`: `const kindle = useKindle();`, add the route `path === "/settings" ? <SettingsPage /> :` before the notifications route, and pass `kindle={kindle}` to `<Library>`.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsPage.tsx web/src/components/SettingsPage.test.tsx web/src/components/Header.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css
git commit -m "feat(web): Settings page with the Kindle address and setup steps"
```

---

### Task 11: `kindle_bounce` renderer entry, docs, backlog

**Files:**
- Modify: `web/src/notifications/api.ts`, `web/src/notifications/render.ts`, `web/src/components/NotificationItem.tsx`, `web/src/components/NotificationBell.tsx`, `web/src/components/NotificationsPage.tsx`, `web/src/App.tsx`, `README.md`, `infra/README.md`, `BACKLOG.md`
- Test: `web/src/notifications/render.test.ts`, `web/src/components/NotificationItem.test.tsx`

**Interfaces:**
- Produces: web `NotificationType` gains `"kindle_bounce"`; `RenderContext` gains `sender?: string`; `NotificationItem`, `NotificationBell`, `NotificationsPage` accept an optional `sender?: string` prop threaded to the renderer; `Shell` passes `auth.kindleSender`.

- [ ] **Step 1: Write the failing tests**

`render.test.ts`:

```ts
  it("kindle_bounce names the book and the sender and links to settings", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com" };
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "Permanent/General" }), ctx2))
      .toEqual({ icon: "📵", text: 'Your Kindle rejected "Black Hound of Death" — add library@lit.example.com to your approved senders', href: "/settings" });
    expect(renderNotification(mk("kindle_bounce", { bookId: "zz", kind: "Bounce", reason: "x" }), ctx2).text)
      .toBe('Your Kindle rejected "a book" — add library@lit.example.com to your approved senders');
  });
```

`NotificationItem.test.tsx`: one test rendering a `kindle_bounce` notification with `sender="library@lit.example.com"` and asserting the link text and `href="/settings"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/notifications/render.test.ts src/components/NotificationItem.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`api.ts`: add `| "kindle_bounce"` to `NotificationType`. `render.ts`: `RenderContext { titleOf(bookId): string | undefined; sender?: string }` and the entry:

```ts
  kindle_bounce: (p, ctx) => {
    const title = typeof p.bookId === "string" ? ctx.titleOf(p.bookId) : undefined;
    return { icon: "📵", text: `Your Kindle rejected "${title ?? "a book"}" — add ${ctx.sender ?? "the library address"} to your approved senders`, href: "/settings" };
  },
```

`NotificationItem` gets `sender?: string` and passes `{ titleOf, sender }` to `renderNotification`; `NotificationBell` and `NotificationsPage` get `sender?: string` and forward it; `Shell` passes `sender={auth.kindleSender}` to both.

**README** — in "What it does" add:

```markdown
- **Send to Kindle.** One click emails the EPUB (or PDF) to your `@kindle.com`
  address through Amazon SES, up to 28 MB; a bounce turns into a notification
  telling you to approve the sender. Sends happen synchronously in one Lambda,
  which is right for a handful of readers — if volume ever grows, the upgrade
  path is an SQS queue and a worker Lambda.
```

Diagram: nodes `KIN[kindle Lambda]`, `SES[(SES)]`, `KEV[kindle-events Lambda]`; edges `API --> KIN --> SES`, `KIN -->|log| DDB`, `SES -.->|bounce| KEV --> NOTIFT`. Repository layout: "six Lambdas"; scripts row unchanged. Security notes: "Every Lambda writes structured JSON events (`event` field) to CloudWatch Logs; the two Kindle Lambdas keep them 3 months." Update the three test counts.

**infra/README** — add sections:

```markdown
## Send to Kindle (SES)

The stack verifies the site domain in SES with Easy DKIM (three CNAMEs in the hosted
zone) and sends from `kindleSender` (`config.local.json`). One-time steps:

1. **Sandbox testing.** New SES accounts are sandboxed: mail goes only to verified
   addresses. SES console → Identities → Create identity → *Email address* → your own
   `@kindle.com` address; click the confirmation link Amazon emails (it lands in your
   Kindle library as a document — open it there). Add the sender to your Amazon
   approved personal-document senders. Then `/settings` → save the address → send a
   small EPUB.
2. **Production access.** SES → Account dashboard → *Request production access*:
   transactional mail, personal library, tens of messages a month. Until approved,
   other users see "Kindle delivery isn't enabled for everyone yet".

Bounces, complaints, and rejects reach the `kindle-events` Lambda, which notifies the
user, logs `kindle.bounce`, and emails the alerts topic.

## Reviewing events

Every Lambda writes one JSON line per business event with an `event` field. In
CloudWatch Logs Insights, select the Lambda log groups and run:

    filter ispresent(event) | sort @timestamp desc | limit 200

or narrow to `filter event like /^kindle\./`. Events: `download.issued`,
`suggestion.created|accepted|rejected`, `category.created`, `notification.fanout`,
`kindle.sent`, `kindle.oversize`, `kindle.send_failed`, `kindle.bounce`. Kindle Lambdas
keep logs 3 months; the others 1 month.
```

**BACKLOG**: move #7 to Done (`infra/lib/kindle.ts`, spec/plan `2026-09-05-send-to-kindle`); "Soon" becomes empty or the next item.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/notifications/api.ts web/src/notifications/render.ts web/src/notifications/render.test.ts web/src/components/NotificationItem.tsx web/src/components/NotificationItem.test.tsx web/src/components/NotificationBell.tsx web/src/components/NotificationsPage.tsx web/src/App.tsx README.md infra/README.md BACKLOG.md
git commit -m "feat(web): kindle_bounce notification; docs for Send to Kindle and event review"
```

---

### Task 12: Deploy and smoke test (controller; needs AWS credentials and Jay)

- [ ] **Step 1**: `cd infra && npx cdk diff` — additive: SES identity, 3 CNAMEs, configuration set + event destination, SNS topic + subscription, two Lambdas + roles, 3 routes, 2 alarms, `KindleSender` output; in-place changes on the existing Lambdas (log lines only). No replacements. Then `npm run deploy`, `python3 ../scripts/apply-outputs.py`, `python3 ../scripts/write-web-env.py`.
- [ ] **Step 2**: `aws sesv2 get-email-identity --email-identity lit.davidjdrake.com --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'` → wait for `SUCCESS` (minutes).
- [ ] **Step 3** (Jay): SES console → verify your own Kindle address as a sandbox identity (confirmation arrives as a Kindle document); Amazon → add `library@lit.davidjdrake.com` to approved senders.
- [ ] **Step 4**: `scripts/deploy-web.sh` → `/settings` → save address → open a small EPUB → Send to Kindle → toast → the book appears on the Kindle.
- [ ] **Step 5**: bounce test — remove the sender from the approved list, send again → bell shows the 📵 row, the alerts email arrives; restore the sender.
- [ ] **Step 6** (Jay): request SES production access. `scripts/backup.sh`.
