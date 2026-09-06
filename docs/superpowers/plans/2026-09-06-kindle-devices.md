# Multiple Kindle Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single stored Kindle address with a named device list, a default, a send-time device picker, and a bounce notification that names the device.

**Architecture:** The settings row body changes from `{kindleAddress}` to `{devices, defaultDeviceId}`, migrated lazily on read so no backfill runs. The two address routes are replaced by a read-whole/replace-whole device list pair, keeping the route count flat. The send handler resolves a device id (defaulting to the user's default) and tags the outgoing message with it, so a bounce carries the device id and the web renderer resolves it to a label from the list it has already loaded.

**Tech Stack:** AWS CDK v2 (`aws-cdk-lib` 2.268), Node 22 Lambdas (esbuild bundling, `@aws-sdk/client-sesv2`, `lib-dynamodb`), vitest for infra and web, React 19 + Vite + TypeScript SPA, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-06-kindle-devices-design.md`

## Global Constraints

- Device id: 8 lowercase hex characters. New ids are random; the migrated legacy device's id is the first 8 hex characters of the SHA-256 of its lowercased address. The alphabet must stay inside SES's tag charset `[A-Za-z0-9_-]`.
- `MAX_DEVICES = 5`, `MAX_LABEL = 30`. Labels are trimmed, non-empty, unique per user case-insensitively. The empty label is reserved for a migrated device and is never accepted from a client.
- Address rule unchanged: `^[A-Za-z0-9._+-]+@kindle\.com$`, case-insensitive, stored lowercased, unique per user.
- A list of exactly one device is normalised before validation: that device is the default whatever the client sent.
- Settings row stays `pk = USER#<email>`, `sk = SETTINGS`. Writing an empty list deletes the row. A write replaces the whole item, so the legacy `kindleAddress` field disappears on first save.
- API: `GET /api/kindle/devices` → 200 `{devices:[{id,label,address}], defaultDeviceId}`; `PUT /api/kindle/devices` → 200 with the canonical list; `POST /api/kindle/send` gains optional `deviceId` and returns 202 `{sentTo, format, deviceId, deviceLabel}`.
- Error bodies are JSON `{error, message?}`. Exact codes and messages:
  - `bad_request` — `Body must be JSON {devices, defaultDeviceId?}`
  - `bad_label` — `Give the device a name of 30 characters or fewer` / duplicate: `You already have a device with that name`
  - `bad_address` — `Enter your @kindle.com address` / duplicate: `That address is already saved`
  - `too_many` — `You can save up to 5 devices`
  - `bad_default` — `Choose one of your devices as the default`
  - `unknown_device` — `That device is no longer saved — reload and try again`
- Send keeps every existing status, including `409 {error:"no_address"}` for an empty list, which is what opens the inline form.
- SES email tags on the outgoing message: `recipient` (hex-encoded email), `bookId`, and new `deviceId` (verbatim).
- UI copy (exact): book dialog button `Send to <target>` where target is the device label or `Kindle` when unnamed/absent; PDF button `Send PDF to <target>`; sending state `Sending…`; oversize tooltip `Too large for Kindle delivery — download instead`; caret button accessible name `Choose a device`; toast `Sent to <label> — it usually arrives within a couple of minutes`, falling back to the address when the label is empty.
- Settings copy (exact): heading `Your devices`; add-form heading `Add a device`; fields `Name` and `Your Kindle email`; buttons `Add device`, `Make default`, `Remove`; default marker `default`; unnamed placeholder `Name this device`; unnamed hint `Name this device so you can tell it apart`; cap note `You can save up to 5 devices`. The help link `Where do I find this?` → `https://www.amazon.com/hz/mycd/myx#/home/settings/payment` belongs to the device form as shown in the book dialog; on Settings the same URL is already linked from the one-time-setup steps, so the form there hides it.
- Bounce row copy (exact): known device `<label> rejected "<title>" — add <sender> to your approved senders`; unknown or missing device `Your Kindle rejected "<title>" — add <sender> to your approved senders`.
- All suites stay offline. Baselines at branch point: infra 189, web 170, indexer 81.
- Never commit real identifiers; fixtures use `library@lit.example.com` and `lit.example.com`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FGG3RznqRahHbbNzUDuphK
  ```

## File Structure

| File | Responsibility |
|---|---|
| `infra/lambda/kindle/devices.ts` (new) | Pure device-list logic: id generation, reading a stored item (with legacy migration), validating and normalising a client list. No AWS calls. |
| `infra/lambda/kindle/store.ts` | DynamoDB read/write of the device list. |
| `infra/lambda/kindle/index.ts` | Routes and send; resolves the target device and tags the message. |
| `infra/lambda/kindle-events/index.ts` | Carries the `deviceId` tag into the notification payload and log event. |
| `infra/lib/kindle.ts` | Route path change. |
| `web/src/kindle/api.ts` | Typed client for the device routes and send. |
| `web/src/kindle/KindleProvider.tsx` | Loads and caches the device list; exposes save and send. |
| `web/src/components/KindleDeviceForm.tsx` (renamed from `KindleAddressForm.tsx`) | Two-field name + address form, shared by the book dialog and Settings. |
| `web/src/components/DeviceList.tsx` (new) | Settings device manager: rows, rename, make default, remove, add. |
| `web/src/components/SendToKindleButton.tsx` (new) | Plain button or split button with the device menu. |
| `web/src/components/BookDetail.tsx` | Uses the button and the form. |
| `web/src/components/Library.tsx` | Toasts and passes the device-aware state to the dialog. |
| `web/src/notifications/render.ts` | `kindle_bounce` resolves the device label. |

---

### Task 1: Device list logic (`devices.ts`)

**Files:**
- Create: `infra/lambda/kindle/devices.ts`
- Test: `infra/test/kindle-devices.test.ts`

**Interfaces:**
- Consumes: `KINDLE_ADDRESS_RE` from `infra/lambda/kindle/lib.ts`.
- Produces:
  ```ts
  export interface KindleDevice { id: string; label: string; address: string; addedAt: string }
  export interface DeviceList { devices: KindleDevice[]; defaultDeviceId: string | null }
  export interface PublicDevice { id: string; label: string; address: string }
  export const MAX_DEVICES = 5;
  export const MAX_LABEL = 30;
  export type DeviceErrorCode = "bad_label" | "bad_address" | "too_many" | "bad_default" | "unknown_device";
  export function newDeviceId(): string;
  export function derivedDeviceId(address: string): string;
  export function readDevices(item: Record<string, unknown> | undefined): DeviceList;
  export function publicList(list: DeviceList): { devices: PublicDevice[]; defaultDeviceId: string | null };
  export type ValidateResult = { ok: true; list: DeviceList } | { ok: false; error: DeviceErrorCode; message: string };
  export function validateDevices(input: unknown, requestedDefault: unknown, existing: DeviceList, now: string): ValidateResult;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// infra/test/kindle-devices.test.ts
import { describe, expect, it } from "vitest";
import { derivedDeviceId, newDeviceId, publicList, readDevices, validateDevices, type DeviceList } from "../lambda/kindle/devices";

const NOW = "2026-09-06T12:00:00.000Z";
const empty: DeviceList = { devices: [], defaultDeviceId: null };
const one: DeviceList = {
  devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW }],
  defaultDeviceId: "aaaaaaaa",
};
const two: DeviceList = {
  devices: [
    { id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW },
    { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com", addedAt: NOW },
  ],
  defaultDeviceId: "bbbbbbbb",
};

describe("ids", () => {
  it("generates 8 hex characters, distinct per call", () => {
    const a = newDeviceId(), b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
  it("derives a stable id from an address, case-insensitively", () => {
    expect(derivedDeviceId("Me_X@Kindle.com")).toBe(derivedDeviceId("me_x@kindle.com"));
    expect(derivedDeviceId("me_x@kindle.com")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("readDevices", () => {
  it("reads a stored device list and keeps a valid default", () => {
    expect(readDevices({ devices: two.devices, defaultDeviceId: "bbbbbbbb" })).toEqual(two);
  });
  it("falls back to the first device when the stored default is missing", () => {
    expect(readDevices({ devices: two.devices, defaultDeviceId: "gone" }).defaultDeviceId).toBe("aaaaaaaa");
  });
  it("migrates a legacy single address to one unnamed default device", () => {
    const list = readDevices({ kindleAddress: "Me_X@Kindle.com", updatedAt: NOW });
    expect(list.devices).toEqual([{ id: derivedDeviceId("me_x@kindle.com"), label: "", address: "me_x@kindle.com", addedAt: NOW }]);
    expect(list.defaultDeviceId).toBe(derivedDeviceId("me_x@kindle.com"));
  });
  it("reads a missing row, an empty row, and a malformed entry as an empty list", () => {
    expect(readDevices(undefined)).toEqual(empty);
    expect(readDevices({})).toEqual(empty);
    expect(readDevices({ devices: [{ id: 1, label: "x" }] })).toEqual(empty);
  });
});

describe("publicList", () => {
  it("drops addedAt", () => {
    expect(publicList(one)).toEqual({ devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "aaaaaaaa" });
  });
});

describe("validateDevices", () => {
  const ok = (r: ReturnType<typeof validateDevices>) => { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); return r.list; };

  it("assigns an id and addedAt to a new device and makes a lone device the default", () => {
    const list = ok(validateDevices([{ label: " Scribe ", address: "A@Kindle.com" }], "ignored", empty, NOW));
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(list.devices[0]).toMatchObject({ label: "Scribe", address: "a@kindle.com", addedAt: NOW });
    expect(list.defaultDeviceId).toBe(list.devices[0].id);
  });
  it("keeps the id and addedAt of an existing device and renames it", () => {
    const list = ok(validateDevices([{ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" }], undefined, one, "2026-10-01T00:00:00.000Z"));
    expect(list.devices[0]).toEqual({ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com", addedAt: NOW });
  });
  it("accepts a legacy migrated id as existing", () => {
    const legacy = readDevices({ kindleAddress: "me_x@kindle.com", updatedAt: NOW });
    const list = ok(validateDevices([{ id: legacy.devices[0].id, label: "Scribe", address: "me_x@kindle.com" }], undefined, legacy, NOW));
    expect(list.devices[0].id).toBe(legacy.devices[0].id);
  });
  it("honours an explicit default and keeps the existing default when none is sent", () => {
    expect(ok(validateDevices(two.devices, "aaaaaaaa", two, NOW)).defaultDeviceId).toBe("aaaaaaaa");
    expect(ok(validateDevices(two.devices, undefined, two, NOW)).defaultDeviceId).toBe("bbbbbbbb");
  });
  it("falls back to the first device when the kept default was removed", () => {
    const list = ok(validateDevices([two.devices[0]], undefined, two, NOW));
    expect(list.defaultDeviceId).toBe("aaaaaaaa");
  });
  it("accepts an empty list and clears the default", () => {
    expect(ok(validateDevices([], undefined, two, NOW))).toEqual(empty);
  });

  it.each([
    ["missing label", [{ address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["blank label", [{ label: "   ", address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["long label", [{ label: "x".repeat(31), address: "a@kindle.com" }], "bad_label", "Give the device a name of 30 characters or fewer"],
    ["duplicate label", [{ label: "Scribe", address: "a@kindle.com" }, { label: "scribe", address: "b@kindle.com" }], "bad_label", "You already have a device with that name"],
    ["bad address", [{ label: "Scribe", address: "a@example.com" }], "bad_address", "Enter your @kindle.com address"],
    ["duplicate address", [{ label: "One", address: "a@kindle.com" }, { label: "Two", address: "A@kindle.com" }], "bad_address", "That address is already saved"],
  ])("rejects %s", (_name, devices, error, message) => {
    const r = validateDevices(devices, undefined, empty, NOW);
    expect(r).toMatchObject({ ok: false, error, message });
  });

  it("rejects more than five devices", () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({ label: `D${i}`, address: `d${i}@kindle.com` }));
    expect(validateDevices(many, undefined, empty, NOW)).toMatchObject({ ok: false, error: "too_many", message: "You can save up to 5 devices" });
  });
  it("rejects a default that names no device in the list", () => {
    expect(validateDevices(two.devices, "gone", two, NOW)).toMatchObject({ ok: false, error: "bad_default", message: "Choose one of your devices as the default" });
  });
  it("rejects an id the user does not have", () => {
    expect(validateDevices([{ id: "cccccccc", label: "Ghost", address: "c@kindle.com" }], undefined, two, NOW))
      .toMatchObject({ ok: false, error: "unknown_device", message: "That device is no longer saved — reload and try again" });
  });
  it("rejects a non-array input", () => {
    expect(validateDevices("nope", undefined, empty, NOW)).toMatchObject({ ok: false, error: "bad_label" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-devices.test.ts`
Expected: FAIL — cannot resolve `../lambda/kindle/devices`.

- [ ] **Step 3: Write the implementation**

```ts
// infra/lambda/kindle/devices.ts
import { createHash, randomBytes } from "node:crypto";
import { KINDLE_ADDRESS_RE } from "./lib";

export interface KindleDevice { id: string; label: string; address: string; addedAt: string }
export interface DeviceList { devices: KindleDevice[]; defaultDeviceId: string | null }
export interface PublicDevice { id: string; label: string; address: string }

export const MAX_DEVICES = 5;
export const MAX_LABEL = 30;

export type DeviceErrorCode = "bad_label" | "bad_address" | "too_many" | "bad_default" | "unknown_device";
export type ValidateResult = { ok: true; list: DeviceList } | { ok: false; error: DeviceErrorCode; message: string };

const MESSAGES = {
  bad_label: "Give the device a name of 30 characters or fewer",
  dup_label: "You already have a device with that name",
  bad_address: "Enter your @kindle.com address",
  dup_address: "That address is already saved",
  too_many: "You can save up to 5 devices",
  bad_default: "Choose one of your devices as the default",
  unknown_device: "That device is no longer saved — reload and try again",
} as const;

const fail = (error: DeviceErrorCode, message: string): ValidateResult => ({ ok: false, error, message });

/** SES tag values allow [A-Za-z0-9_-]; hex keeps ids usable as a tag without encoding. */
export const newDeviceId = (): string => randomBytes(4).toString("hex");

/** Stable id for a migrated legacy address, so reading twice without a write agrees. */
export const derivedDeviceId = (address: string): string =>
  createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 8);

function isStoredDevice(v: unknown): v is KindleDevice {
  const d = v as Partial<KindleDevice> | null;
  return !!d && typeof d.id === "string" && typeof d.label === "string"
    && typeof d.address === "string" && typeof d.addedAt === "string";
}

export function readDevices(item: Record<string, unknown> | undefined): DeviceList {
  const raw = item?.devices;
  if (Array.isArray(raw)) {
    const devices = raw.filter(isStoredDevice);
    if (devices.length === 0) return { devices: [], defaultDeviceId: null };
    const stored = item?.defaultDeviceId;
    const def = typeof stored === "string" && devices.some((d) => d.id === stored) ? stored : devices[0].id;
    return { devices, defaultDeviceId: def };
  }
  const legacy = item?.kindleAddress;
  if (typeof legacy === "string" && legacy.trim()) {
    const address = legacy.trim().toLowerCase();
    const id = derivedDeviceId(address);
    const addedAt = typeof item?.updatedAt === "string" ? item.updatedAt : "";
    return { devices: [{ id, label: "", address, addedAt }], defaultDeviceId: id };
  }
  return { devices: [], defaultDeviceId: null };
}

export const publicList = (list: DeviceList) => ({
  devices: list.devices.map(({ id, label, address }) => ({ id, label, address })),
  defaultDeviceId: list.defaultDeviceId,
});

export function validateDevices(input: unknown, requestedDefault: unknown, existing: DeviceList, now: string): ValidateResult {
  if (!Array.isArray(input)) return fail("bad_label", MESSAGES.bad_label);
  if (input.length > MAX_DEVICES) return fail("too_many", MESSAGES.too_many);

  const byId = new Map(existing.devices.map((d) => [d.id, d]));
  const devices: KindleDevice[] = [];
  const labels = new Set<string>();
  const addresses = new Set<string>();

  for (const raw of input) {
    const entry = (raw ?? {}) as { id?: unknown; label?: unknown; address?: unknown };

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label || label.length > MAX_LABEL) return fail("bad_label", MESSAGES.bad_label);
    if (labels.has(label.toLowerCase())) return fail("bad_label", MESSAGES.dup_label);
    labels.add(label.toLowerCase());

    const address = typeof entry.address === "string" ? entry.address.trim().toLowerCase() : "";
    if (!KINDLE_ADDRESS_RE.test(address)) return fail("bad_address", MESSAGES.bad_address);
    if (addresses.has(address)) return fail("bad_address", MESSAGES.dup_address);
    addresses.add(address);

    if (typeof entry.id === "string" && entry.id) {
      const known = byId.get(entry.id);
      if (!known) return fail("unknown_device", MESSAGES.unknown_device);
      devices.push({ id: known.id, label, address, addedAt: known.addedAt });
    } else {
      devices.push({ id: newDeviceId(), label, address, addedAt: now });
    }
  }

  if (devices.length === 0) return { ok: true, list: { devices: [], defaultDeviceId: null } };
  // A single device is always its own default, whatever the client asked for.
  if (devices.length === 1) return { ok: true, list: { devices, defaultDeviceId: devices[0].id } };

  if (typeof requestedDefault === "string" && requestedDefault) {
    if (!devices.some((d) => d.id === requestedDefault)) return fail("bad_default", MESSAGES.bad_default);
    return { ok: true, list: { devices, defaultDeviceId: requestedDefault } };
  }
  const kept = existing.defaultDeviceId && devices.some((d) => d.id === existing.defaultDeviceId)
    ? existing.defaultDeviceId : devices[0].id;
  return { ok: true, list: { devices, defaultDeviceId: kept } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/kindle-devices.test.ts && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/devices.ts infra/test/kindle-devices.test.ts
git commit -m "feat(kindle): device list model, legacy migration, and validation"
```

---

### Task 2: Device list persistence (`store.ts`)

**Files:**
- Modify: `infra/lambda/kindle/store.ts`
- Test: `infra/test/kindle-store.test.ts`

**Interfaces:**
- Consumes: `readDevices`, `DeviceList` from Task 1.
- Produces: `DynamoKindleStore` with
  ```ts
  getDevices(email: string): Promise<DeviceList>;
  setDevices(email: string, list: DeviceList, updatedAt: string): Promise<void>;
  ```
  `getAddress`/`setAddress` are removed.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `infra/test/kindle-store.test.ts` with:

```ts
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { derivedDeviceId, type DeviceList } from "../lambda/kindle/devices";
import { DynamoKindleStore } from "../lambda/kindle/store";

const NOW = "2026-09-06T12:00:00.000Z";
function client(item?: Record<string, unknown>) {
  const sent: unknown[] = [];
  const ddb = { send: vi.fn(async (cmd: unknown) => { sent.push(cmd); return cmd instanceof GetCommand ? { Item: item } : {}; }) };
  return { ddb: ddb as never, sent };
}

describe("DynamoKindleStore", () => {
  it("reads the caller's own row only", async () => {
    const { ddb, sent } = client({ devices: [], defaultDeviceId: null });
    await new DynamoKindleStore(ddb, "T").getDevices("Jay@Example.com");
    expect((sent[0] as GetCommand).input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });

  it("migrates a legacy address row on read without writing", async () => {
    const { ddb, sent } = client({ kindleAddress: "me_x@kindle.com", updatedAt: NOW });
    const list = await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com");
    expect(list.devices).toEqual([{ id: derivedDeviceId("me_x@kindle.com"), label: "", address: "me_x@kindle.com", addedAt: NOW }]);
    expect(sent).toHaveLength(1);
  });

  it("reads a missing row as an empty list", async () => {
    const { ddb } = client(undefined);
    expect(await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com")).toEqual({ devices: [], defaultDeviceId: null });
  });

  it("writes the whole item, dropping any legacy field", async () => {
    const { ddb, sent } = client();
    const list: DeviceList = { devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW }], defaultDeviceId: "aaaaaaaa" };
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", list, NOW);
    expect((sent[0] as PutCommand).input).toEqual({
      TableName: "T",
      Item: { pk: "USER#jay@example.com", sk: "SETTINGS", devices: list.devices, defaultDeviceId: "aaaaaaaa", updatedAt: NOW },
    });
  });

  it("deletes the row when the list is empty", async () => {
    const { ddb, sent } = client();
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", { devices: [], defaultDeviceId: null }, NOW);
    expect(sent[0]).toBeInstanceOf(DeleteCommand);
    expect((sent[0] as DeleteCommand).input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-store.test.ts`
Expected: FAIL — `getDevices` is not a function.

- [ ] **Step 3: Write the implementation**

Replace the body of `infra/lambda/kindle/store.ts` with:

```ts
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readDevices, type DeviceList } from "./devices";
import type { KindleStore } from "./index";

const SK = "SETTINGS";
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

// Per-user settings live in the library table next to the overlay rows; only the
// caller's own pk is ever touched. A legacy {kindleAddress} row is migrated on read
// and disappears on the next write, because Put replaces the whole item.
export class DynamoKindleStore implements KindleStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async getDevices(email: string): Promise<DeviceList> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
    return readDevices(out.Item);
  }

  async setDevices(email: string, list: DeviceList, updatedAt: string): Promise<void> {
    if (list.devices.length === 0) {
      await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
      return;
    }
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { pk: pkOf(email), sk: SK, devices: list.devices, defaultDeviceId: list.defaultDeviceId, updatedAt },
    }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/kindle-store.test.ts`
Expected: PASS. The handler test file still references the old store interface and will fail to typecheck until Task 3; that is expected, so do not run `tsc` here.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/store.ts infra/test/kindle-store.test.ts
git commit -m "feat(kindle): store the device list, migrating the legacy address on read"
```

---

### Task 3: Device routes (`GET`/`PUT /api/kindle/devices`) and CDK path

**Files:**
- Modify: `infra/lambda/kindle/index.ts`, `infra/lib/kindle.ts:100`
- Test: `infra/test/kindle-handler.test.ts`, `infra/test/kindle-stack.test.ts`

**Interfaces:**
- Consumes: `readDevices`, `validateDevices`, `publicList`, `DeviceList` from Task 1; `getDevices`/`setDevices` from Task 2.
- Produces: `KindleStore` interface on `Deps` becomes `{ getDevices, setDevices }`. Route paths `/api/kindle/devices` (GET, PUT) and `/api/kindle/send` (POST).

- [ ] **Step 1: Write the failing tests**

In `infra/test/kindle-handler.test.ts`, replace the store stub and the address-route tests. The existing file builds `Deps` in a helper; update that helper to the new store shape and add these tests:

```ts
// helper — replace the existing store stub with this shape
function storeStub(list: DeviceList = { devices: [], defaultDeviceId: null }) {
  const saved: Array<{ list: DeviceList; updatedAt: string }> = [];
  return {
    saved,
    store: {
      getDevices: async () => list,
      setDevices: async (_e: string, l: DeviceList, updatedAt: string) => { saved.push({ list: l, updatedAt }); },
    },
  };
}
const ev = (method: string, path: string, body?: unknown) => ({
  rawPath: path,
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: "jay@example.com" } } } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}) as never;
const parse = (r: unknown) => JSON.parse((r as { body: string }).body);

const TWO: DeviceList = {
  devices: [
    { id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: "2026-09-01T00:00:00.000Z" },
    { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com", addedAt: "2026-09-01T00:00:00.000Z" },
  ],
  defaultDeviceId: "bbbbbbbb",
};

describe("device routes", () => {
  it("GET returns the list without addedAt", async () => {
    const { store } = storeStub(TWO);
    const res = await handle(ev("GET", "/api/kindle/devices"), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(parse(res)).toEqual({
      devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com" }, { id: "bbbbbbbb", label: "Phone", address: "b@kindle.com" }],
      defaultDeviceId: "bbbbbbbb",
    });
  });

  it("PUT saves the canonical list and returns it", async () => {
    const { store, saved } = storeStub(TWO);
    const res = await handle(ev("PUT", "/api/kindle/devices", {
      devices: [{ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" }, { label: "New", address: "c@kindle.com" }],
      defaultDeviceId: "aaaaaaaa",
    }), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const body = parse(res);
    expect(body.devices[0]).toEqual({ id: "aaaaaaaa", label: "Study Scribe", address: "a@kindle.com" });
    expect(body.devices[1].id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.defaultDeviceId).toBe("aaaaaaaa");
    expect(saved).toHaveLength(1);
    expect(saved[0].list.devices[0].addedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("PUT rejects a malformed body before touching the store", async () => {
    const { store, saved } = storeStub(TWO);
    const res = await handle(ev("PUT", "/api/kindle/devices", { nope: 1 }), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(parse(res)).toEqual({ error: "bad_request", message: "Body must be JSON {devices, defaultDeviceId?}" });
    expect(saved).toHaveLength(0);
  });

  it("PUT surfaces a validation failure and saves nothing", async () => {
    const { store, saved } = storeStub(TWO);
    const res = await handle(ev("PUT", "/api/kindle/devices", { devices: [{ label: "", address: "a@kindle.com" }] }), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(parse(res)).toEqual({ error: "bad_label", message: "Give the device a name of 30 characters or fewer" });
    expect(saved).toHaveLength(0);
  });

  it("PUT with an empty list clears the setting", async () => {
    const { store, saved } = storeStub(TWO);
    const res = await handle(ev("PUT", "/api/kindle/devices", { devices: [] }), deps({ store }));
    expect(parse(res)).toEqual({ devices: [], defaultDeviceId: null });
    expect(saved[0].list.devices).toEqual([]);
  });

  it("still 404s an unknown path and 401s a token with no email", async () => {
    const { store } = storeStub(TWO);
    expect((await handle(ev("GET", "/api/kindle/address"), deps({ store })) as { statusCode: number }).statusCode).toBe(404);
  });
});
```

Add to `infra/test/kindle-stack.test.ts`:

```ts
  it("routes the device list and send paths", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /api/kindle/devices" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "PUT /api/kindle/devices" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /api/kindle/send" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-handler.test.ts test/kindle-stack.test.ts`
Expected: FAIL — the handler still serves `/api/kindle/address`; the stack still declares that route.

- [ ] **Step 3: Write the implementation**

In `infra/lambda/kindle/index.ts`, change the store interface and the two routes:

```ts
import { publicList, validateDevices, type DeviceList } from "./devices";

export interface KindleStore {
  getDevices(email: string): Promise<DeviceList>;
  /** An empty list deletes the settings row. */
  setDevices(email: string, list: DeviceList, updatedAt: string): Promise<void>;
}
```

Replace the two address route blocks inside `handle` with:

```ts
    if (method === "GET" && path === "/api/kindle/devices") {
      return json(200, publicList(await deps.store.getDevices(email)));
    }
    if (method === "PUT" && path === "/api/kindle/devices") {
      const body = parseBody(event.body);
      if (!Array.isArray(body.devices)) {
        return json(400, { error: "bad_request", message: "Body must be JSON {devices, defaultDeviceId?}" });
      }
      const existing = await deps.store.getDevices(email);
      const result = validateDevices(body.devices, body.defaultDeviceId, existing, deps.now().toISOString());
      if (!result.ok) return json(400, { error: result.error, message: result.message });
      await deps.store.setDevices(email, result.list, deps.now().toISOString());
      return json(200, publicList(result.list));
    }
```

Remove the now-unused `parseKindleAddress` from the import at the top of the file.

In `infra/lib/kindle.ts:100`, change the path:

```ts
    props.httpApi.addRoutes({ path: "/api/kindle/devices", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.PUT], integration });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run test/kindle-handler.test.ts test/kindle-stack.test.ts`
Expected: PASS. Send tests in the same file still use the old store and fail until Task 4; if so, note it and continue.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/index.ts infra/lib/kindle.ts infra/test/kindle-handler.test.ts infra/test/kindle-stack.test.ts
git commit -m "feat(kindle): replace the address routes with a device list"
```

---

### Task 4: Send to a chosen device

**Files:**
- Modify: `infra/lambda/kindle/index.ts` (the `sendBook` function)
- Test: `infra/test/kindle-handler.test.ts`

**Interfaces:**
- Consumes: `KindleStore.getDevices` from Task 3.
- Produces: `POST /api/kindle/send` accepts `deviceId`; 202 body `{sentTo, format, deviceId, deviceLabel}`; SES tags gain `deviceId`; `kindle.sent` and `kindle.send_failed` log events gain `deviceId`.

- [ ] **Step 1: Write the failing tests**

Add to `infra/test/kindle-handler.test.ts`, reusing `storeStub`, `ev`, `parse`, and `TWO` from Task 3:

```ts
describe("send targets a device", () => {
  it("sends to the default device and reports its label", async () => {
    const sent: Array<{ raw: string; tags: Record<string, string> }> = [];
    const { store } = storeStub(TWO);
    const res = await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store, sender: { send: async (raw, tags) => { sent.push({ raw, tags }); return { messageId: "m1" }; } } }));
    expect((res as { statusCode: number }).statusCode).toBe(202);
    expect(parse(res)).toEqual({ sentTo: "b@kindle.com", format: "epub", deviceId: "bbbbbbbb", deviceLabel: "Phone" });
    expect(sent[0].tags.deviceId).toBe("bbbbbbbb");
    expect(sent[0].raw).toContain("To: b@kindle.com");
  });

  it("sends to an explicitly chosen device", async () => {
    const sent: Array<{ tags: Record<string, string> }> = [];
    const { store } = storeStub(TWO);
    const res = await handle(ev("POST", "/api/kindle/send", { bookId: "b1", deviceId: "aaaaaaaa" }), deps({ store, sender: { send: async (_r, tags) => { sent.push({ tags }); return { messageId: "m1" }; } } }));
    expect(parse(res)).toMatchObject({ sentTo: "a@kindle.com", deviceId: "aaaaaaaa", deviceLabel: "Scribe" });
    expect(sent[0].tags.deviceId).toBe("aaaaaaaa");
  });

  it("rejects a device the user no longer has", async () => {
    const { store } = storeStub(TWO);
    const res = await handle(ev("POST", "/api/kindle/send", { bookId: "b1", deviceId: "gone" }), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(parse(res)).toEqual({ error: "unknown_device", message: "That device is no longer saved — reload and try again" });
  });

  it("409s with no devices saved", async () => {
    const { store } = storeStub({ devices: [], defaultDeviceId: null });
    const res = await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store }));
    expect((res as { statusCode: number }).statusCode).toBe(409);
    expect(parse(res)).toEqual({ error: "no_address" });
  });

  it("reports an empty label for an unnamed migrated device", async () => {
    const legacy: DeviceList = { devices: [{ id: "abcd1234", label: "", address: "me_x@kindle.com", addedAt: "" }], defaultDeviceId: "abcd1234" };
    const { store } = storeStub(legacy);
    const res = await handle(ev("POST", "/api/kindle/send", { bookId: "b1" }), deps({ store }));
    expect(parse(res)).toMatchObject({ sentTo: "me_x@kindle.com", deviceLabel: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-handler.test.ts`
Expected: FAIL — `sendBook` still calls `getAddress`.

- [ ] **Step 3: Write the implementation**

In `sendBook`, replace the address lookup:

```ts
  const { devices, defaultDeviceId } = await deps.store.getDevices(email);
  if (devices.length === 0) return json(409, { error: "no_address" });
  const requestedDeviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId : undefined;
  const device = requestedDeviceId
    ? devices.find((d) => d.id === requestedDeviceId)
    : devices.find((d) => d.id === defaultDeviceId) ?? devices[0];
  if (!device) return json(400, { error: "unknown_device", message: "That device is no longer saved — reload and try again" });
```

Then use `device.address` where `address` was used, tag the message, and widen the response and log events:

```ts
  const raw = buildMime({
    from: deps.senderAddress, to: device.address, subject: book.title,
    filename: downloadFilename(book.title, type, book.id), contentType: CONTENT_TYPES[type], body: bytes, date: deps.now(),
  });
  let messageId: string;
  try {
    ({ messageId } = await deps.sender.send(raw, { recipient: tagValue(email), bookId, deviceId: device.id }));
  } catch (e) {
    const code = classifySesError(e);
    console.error("kindle send failed:", e);
    logEvent("kindle.send_failed", { email, bookId, format: type, deviceId: device.id, code, reason: (e as Error).message }, deps.now);
    return json(502, { error: code, message: code === "not_enabled" ? NOT_ENABLED_MESSAGE : "Could not send the book right now" });
  }
```

and at the end:

```ts
  logEvent("kindle.sent", { email, bookId, format: type, deviceId: device.id, bytes: bytes.byteLength, sesMessageId: messageId }, deps.now);
  return json(202, { sentTo: device.address, format: type, deviceId: device.id, deviceLabel: device.label });
```

Leave the catalog, oversize, object-load, and downloads-row branches exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run && npx tsc --noEmit`
Expected: PASS, typecheck clean. The whole infra suite should be green again at this point.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle/index.ts infra/test/kindle-handler.test.ts
git commit -m "feat(kindle): send to a chosen device and tag the message with it"
```

---

### Task 5: Bounces carry the device id

**Files:**
- Modify: `infra/lambda/kindle-events/index.ts`
- Test: `infra/test/kindle-events.test.ts`

**Interfaces:**
- Consumes: the `deviceId` SES tag from Task 4.
- Produces: `kindle_bounce` notification payload `{bookId, kind, reason, deviceId}` and `kindle.bounce` log event with `deviceId`.

- [ ] **Step 1: Write the failing test**

Add to `infra/test/kindle-events.test.ts`:

```ts
  it("carries the deviceId tag into the notification and the log event", async () => {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => { lines.push(l); });
    try {
      await handle(snsEvent({
        eventType: "Bounce",
        mail: { messageId: "ses-1", timestamp: "2026-09-06T10:00:00.000Z", tags: { recipient: [Buffer.from("jay@example.com").toString("hex")], bookId: ["b1"], deviceId: ["aaaaaaaa"] } },
        bounce: { bounceType: "Permanent", bounceSubType: "General" },
      }), {
        notify: async (type, payload) => { calls.push({ type, payload }); },
        alert: async () => {},
        now: () => new Date("2026-09-06T11:00:00.000Z"),
      });
    } finally { spy.mockRestore(); }
    expect(calls[0].payload).toMatchObject({ bookId: "b1", kind: "Bounce", deviceId: "aaaaaaaa" });
    expect(JSON.parse(lines[0])).toMatchObject({ event: "kindle.bounce", deviceId: "aaaaaaaa" });
  });

  it("still works for a message sent before device ids existed", async () => {
    const calls: Array<{ payload: Record<string, unknown> }> = [];
    await handle(snsEvent({
      eventType: "Bounce",
      mail: { messageId: "ses-2", tags: { recipient: [Buffer.from("jay@example.com").toString("hex")], bookId: ["b1"] } },
      bounce: { bounceType: "Permanent", bounceSubType: "General" },
    }), { notify: async (_t, payload) => { calls.push({ payload }); }, alert: async () => {}, now: () => new Date() });
    expect(calls[0].payload.deviceId).toBe("");
  });
```

Reuse the file's existing `snsEvent` helper. If it does not accept a full event object, extend it rather than duplicating it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra && npx vitest run test/kindle-events.test.ts`
Expected: FAIL — the payload has no `deviceId`.

- [ ] **Step 3: Write the implementation**

In the record loop of `infra/lambda/kindle-events/index.ts`, read the tag and pass it through:

```ts
    const bookId = ev.mail?.tags?.bookId?.[0] ?? "";
    const deviceId = ev.mail?.tags?.deviceId?.[0] ?? "";
```

then

```ts
      await deps.notify("kindle_bounce", { bookId, kind, reason, deviceId }, [recipient], notifyOpts);
      logEvent("kindle.bounce", { recipient, bookId, deviceId, kind, reason, sesMessageId }, deps.now);
```

Leave the failure counting, the throw after the loop, and the clock derivation untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra && npx vitest run && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/kindle-events/index.ts infra/test/kindle-events.test.ts
git commit -m "feat(kindle-events): record which device rejected the book"
```

---

### Task 6: Web client for the device routes

**Files:**
- Modify: `web/src/kindle/api.ts`
- Test: `web/src/kindle/api.test.ts`

**Interfaces:**
- Consumes: the routes from Tasks 3 and 4.
- Produces:
  ```ts
  export interface KindleDevice { id: string; label: string; address: string }
  export interface DeviceInput { id?: string; label: string; address: string }
  export interface DeviceListDto { devices: KindleDevice[]; defaultDeviceId: string | null }
  export type KindleErrorCode = "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed"
    | "unknown_device" | "bad_request" | "bad_label" | "bad_address" | "too_many" | "bad_default";
  export function getKindleDevices(apiUrl: string, idToken: string, fetchFn?: typeof fetch): Promise<DeviceListDto>;
  export function saveKindleDevices(apiUrl: string, idToken: string, devices: DeviceInput[], defaultDeviceId?: string, fetchFn?: typeof fetch): Promise<DeviceListDto>;
  export function sendToKindle(apiUrl: string, idToken: string, bookId: string, format?: string, deviceId?: string, fetchFn?: typeof fetch): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }>;
  ```
  `getKindleAddress` and `saveKindleAddress` are removed. `KindleError` keeps its shape.

- [ ] **Step 1: Write the failing tests**

Create `web/src/kindle/api.test.ts`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { getKindleDevices, KindleError, saveKindleDevices, sendToKindle } from "./api";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

describe("getKindleDevices", () => {
  it("returns the list and the default", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    expect(await getKindleDevices("/api", "tok", fetchFn)).toEqual({ devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" });
  });
  it("tolerates a malformed body", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: 1 }, { id: "a1", label: "S", address: "a@kindle.com" }] })) as unknown as typeof fetch;
    expect(await getKindleDevices("/api", "tok", fetchFn)).toEqual({ devices: [{ id: "a1", label: "S", address: "a@kindle.com" }], defaultDeviceId: null });
  });
});

describe("saveKindleDevices", () => {
  it("PUTs the list and returns the canonical response", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" }); }) as unknown as typeof fetch;
    const out = await saveKindleDevices("/api", "tok", [{ label: "Scribe", address: "a@kindle.com" }], "a1", fetchFn);
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(String(calls[0].body))).toEqual({ devices: [{ label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" });
    expect(out.devices[0].id).toBe("a1");
  });
  it("omits the default when none is given", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(200, { devices: [], defaultDeviceId: null }); }) as unknown as typeof fetch;
    await saveKindleDevices("/api", "tok", [], undefined, fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ devices: [] });
  });
  it("throws a typed error carrying the server message", async () => {
    const fetchFn = vi.fn(async () => json(400, { error: "bad_label", message: "You already have a device with that name" })) as unknown as typeof fetch;
    await expect(saveKindleDevices("/api", "tok", [], undefined, fetchFn)).rejects.toMatchObject({
      name: "KindleError", code: "bad_label", message: "You already have a device with that name",
    });
  });
});

describe("sendToKindle", () => {
  it("posts the device id and returns the label", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(202, { sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "Scribe" }); }) as unknown as typeof fetch;
    const out = await sendToKindle("/api", "tok", "b1", "epub", "a1", fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ bookId: "b1", format: "epub", deviceId: "a1" });
    expect(out).toEqual({ sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "Scribe" });
  });
  it("omits an absent format and device", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init!); return json(202, { sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "" }); }) as unknown as typeof fetch;
    await sendToKindle("/api", "tok", "b1", undefined, undefined, fetchFn);
    expect(JSON.parse(String(calls[0].body))).toEqual({ bookId: "b1" });
  });
  it("maps 409, 400 unknown_device and 413 to codes", async () => {
    const mk = (status: number, body: unknown) => (vi.fn(async () => json(status, body)) as unknown as typeof fetch);
    await expect(sendToKindle("/api", "t", "b", undefined, undefined, mk(409, { error: "no_address" }))).rejects.toMatchObject({ code: "no_address" });
    await expect(sendToKindle("/api", "t", "b", undefined, "x", mk(400, { error: "unknown_device", message: "gone" }))).rejects.toMatchObject({ code: "unknown_device", message: "gone" });
    await expect(sendToKindle("/api", "t", "b", undefined, undefined, mk(413, { error: "too_large", message: "big", bytes: 9, limit: 8 }))).rejects.toMatchObject({ code: "too_large" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/kindle/api.test.ts`
Expected: FAIL — `getKindleDevices` is not exported.

- [ ] **Step 3: Write the implementation**

Replace `web/src/kindle/api.ts` with:

```ts
import { apiCall } from "../catalog/apiCall";

export interface KindleDevice { id: string; label: string; address: string }
export interface DeviceInput { id?: string; label: string; address: string }
export interface DeviceListDto { devices: KindleDevice[]; defaultDeviceId: string | null }

export type KindleErrorCode =
  | "no_address" | "too_large" | "unsupported" | "not_enabled" | "failed"
  | "unknown_device" | "bad_request" | "bad_label" | "bad_address" | "too_many" | "bad_default";

const CODES = new Set<string>([
  "no_address", "too_large", "unsupported", "not_enabled", "failed",
  "unknown_device", "bad_request", "bad_label", "bad_address", "too_many", "bad_default",
]);

export class KindleError extends Error {
  constructor(public readonly code: KindleErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KindleError";
  }
}

interface ErrorBody { error?: string; message?: string; bytes?: number; limit?: number }

const codeOf = (body: ErrorBody): KindleErrorCode =>
  (typeof body.error === "string" && CODES.has(body.error) ? body.error : "failed") as KindleErrorCode;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return ((await res.json()) as Record<string, unknown>) ?? {}; } catch { return {}; }
}

function toDevice(v: unknown): KindleDevice | undefined {
  const d = v as Partial<KindleDevice> | null;
  return d && typeof d.id === "string" && typeof d.label === "string" && typeof d.address === "string"
    ? { id: d.id, label: d.label, address: d.address } : undefined;
}

function toList(body: Record<string, unknown>): DeviceListDto {
  const devices = Array.isArray(body.devices) ? body.devices.map(toDevice).filter((d): d is KindleDevice => !!d) : [];
  const def = typeof body.defaultDeviceId === "string" && devices.some((d) => d.id === body.defaultDeviceId)
    ? body.defaultDeviceId : null;
  return { devices, defaultDeviceId: def };
}

export async function getKindleDevices(apiUrl: string, idToken: string, fetchFn: typeof fetch = fetch): Promise<DeviceListDto> {
  const res = await apiCall(apiUrl, idToken, "/kindle/devices", { method: "GET" }, 200, fetchFn);
  return toList(await readJson(res));
}

export async function saveKindleDevices(
  apiUrl: string, idToken: string, devices: DeviceInput[], defaultDeviceId?: string, fetchFn: typeof fetch = fetch,
): Promise<DeviceListDto> {
  const res = await fetchFn(`${apiUrl}/kindle/devices`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(defaultDeviceId ? { devices, defaultDeviceId } : { devices }),
  });
  const body = await readJson(res);
  if (res.status === 200) return toList(body);
  const err = body as ErrorBody;
  throw new KindleError(codeOf(err), err.message ?? err.error ?? `Save failed: ${res.status}`);
}

export async function sendToKindle(
  apiUrl: string, idToken: string, bookId: string, format?: string, deviceId?: string, fetchFn: typeof fetch = fetch,
): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }> {
  const res = await fetchFn(`${apiUrl}/kindle/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bookId, ...(format ? { format } : {}), ...(deviceId ? { deviceId } : {}) }),
  });
  const body = await readJson(res);
  if (res.status === 202 && typeof body.sentTo === "string") {
    return {
      sentTo: body.sentTo,
      format: typeof body.format === "string" ? body.format : "",
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
    };
  }
  const err = body as ErrorBody;
  const message = err.message ?? err.error ?? `Send failed: ${res.status}`;
  if (res.status === 409) throw new KindleError("no_address", message);
  if (res.status === 413) throw new KindleError("too_large", message, { bytes: err.bytes, limit: err.limit });
  throw new KindleError(codeOf(err), message);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/kindle/api.test.ts`
Expected: PASS. `KindleProvider.tsx` still imports the removed functions and fails to typecheck until Task 7; that is expected, so do not run `tsc` here.

- [ ] **Step 5: Commit**

```bash
git add web/src/kindle/api.ts web/src/kindle/api.test.ts
git commit -m "feat(web): typed client for the Kindle device routes"
```

---

### Task 7: `KindleProvider` holds the device list

**Files:**
- Modify: `web/src/kindle/KindleProvider.tsx`
- Test: `web/src/kindle/KindleProvider.test.tsx`

**Interfaces:**
- Consumes: `getKindleDevices`, `saveKindleDevices`, `sendToKindle`, `KindleDevice`, `DeviceInput` from Task 6.
- Produces:
  ```ts
  export interface KindleState {
    devices: KindleDevice[] | undefined;   // undefined while loading
    defaultDeviceId: string | null;
    sender: string;
    save(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
    send(bookId: string, format?: string, deviceId?: string): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Replace `web/src/kindle/KindleProvider.test.tsx` with:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindleProvider, useKindle } from "./KindleProvider";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
}) as unknown as Response;

function Probe() {
  const k = useKindle();
  return (
    <div>
      <span data-testid="state">{k.devices === undefined ? "loading" : `${k.devices.length}:${k.defaultDeviceId ?? "-"}`}</span>
      <button onClick={() => void k.save([{ label: "Phone", address: "b@kindle.com" }], undefined)}>save</button>
    </div>
  );
}
const mount = (fetchFn: typeof fetch) => render(
  <KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="library@lit.example.com"><Probe /></KindleProvider>,
);

describe("KindleProvider", () => {
  it("loads the device list", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByTestId("state")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:a1"));
  });

  it("treats a failed load as no devices, so the send path still guards", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("0:-"));
  });

  it("adopts the canonical list returned by a save", async () => {
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => init?.method === "PUT"
      ? json(200, { devices: [{ id: "srv1", label: "Phone", address: "b@kindle.com" }], defaultDeviceId: "srv1" })
      : json(200, { devices: [], defaultDeviceId: null })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("0:-"));
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("1:srv1"));
  });

  it("propagates a save failure to the caller", async () => {
    const errors: string[] = [];
    function Failing() {
      const k = useKindle();
      return <button onClick={() => void k.save([], undefined).catch((e: Error) => errors.push(e.message))}>go</button>;
    }
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => init?.method === "PUT"
      ? json(400, { error: "bad_label", message: "You already have a device with that name" })
      : json(200, { devices: [], defaultDeviceId: null })) as unknown as typeof fetch;
    render(<KindleProvider apiUrl="/api" getIdToken={async () => "tok"} fetchFn={fetchFn} sender="s@x.com"><Failing /></KindleProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(errors).toEqual(["You already have a device with that name"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/kindle/KindleProvider.test.tsx`
Expected: FAIL — the provider still exposes `address`.

- [ ] **Step 3: Write the implementation**

Replace `web/src/kindle/KindleProvider.tsx` with:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getKindleDevices, saveKindleDevices, sendToKindle, type DeviceInput, type KindleDevice } from "./api";

export interface KindleState {
  devices: KindleDevice[] | undefined; // undefined while loading
  defaultDeviceId: string | null;
  sender: string;
  save(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
  send(bookId: string, format?: string, deviceId?: string): Promise<{ sentTo: string; format: string; deviceId: string; deviceLabel: string }>;
}

const Ctx = createContext<KindleState | undefined>(undefined);
interface Props { apiUrl: string; getIdToken: () => Promise<string>; fetchFn?: typeof fetch; sender: string; children: ReactNode }

export function KindleProvider({ apiUrl, getIdToken, fetchFn = fetch, sender, children }: Props) {
  const [devices, setDevices] = useState<KindleDevice[] | undefined>(undefined);
  const [defaultDeviceId, setDefaultDeviceId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getKindleDevices(apiUrl, await getIdToken(), fetchFn);
        if (cancelled) return;
        setDevices(list.devices);
        setDefaultDeviceId(list.defaultDeviceId);
      } catch {
        // the send endpoint's no_address response still guards
        if (!cancelled) { setDevices([]); setDefaultDeviceId(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl, getIdToken, fetchFn]);

  const save = useCallback(async (next: DeviceInput[], nextDefault?: string) => {
    const list = await saveKindleDevices(apiUrl, await getIdToken(), next, nextDefault, fetchFn);
    if (mounted.current) { setDevices(list.devices); setDefaultDeviceId(list.defaultDeviceId); }
  }, [apiUrl, getIdToken, fetchFn]);

  const send = useCallback(
    (bookId: string, format?: string, deviceId?: string) =>
      getIdToken().then((t) => sendToKindle(apiUrl, t, bookId, format, deviceId, fetchFn)),
    [apiUrl, getIdToken, fetchFn],
  );

  const value = useMemo<KindleState>(
    () => ({ devices, defaultDeviceId, sender, save, send }),
    [devices, defaultDeviceId, sender, save, send],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKindle(): KindleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useKindle must be used inside <KindleProvider>");
  return ctx;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/kindle/KindleProvider.test.tsx`
Expected: PASS. `SettingsPage`, `BookDetail`, and `Library` still read `kindle.address` and fail to typecheck until Tasks 9 and 10; that is expected.

- [ ] **Step 5: Commit**

```bash
git add web/src/kindle/KindleProvider.tsx web/src/kindle/KindleProvider.test.tsx
git commit -m "feat(web): provider holds the Kindle device list"
```

---

### Task 8: Two-field device form

**Files:**
- Create: `web/src/components/KindleDeviceForm.tsx`, `web/src/components/KindleDeviceForm.test.tsx`
- Modify: `web/src/kindle/limits.ts`

**Interfaces:**
- Consumes: `KINDLE_ADDRESS_RE`, `KINDLE_HELP_URL` from `web/src/kindle/limits.ts`.
- Produces:
  ```ts
  export const MAX_LABEL = 30;                       // added to limits.ts
  interface Props {
    sender: string;
    submitLabel: string;
    onSubmit(label: string, address: string): Promise<void>;
    onCancel?(): void;
    showHelp?: boolean;   // defaults true
  }
  export default function KindleDeviceForm(props: Props): JSX.Element;
  ```

`KindleAddressForm.tsx` is left in place for now and deleted in Task 10, so every task stays green.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/KindleDeviceForm.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KindleDeviceForm from "./KindleDeviceForm";

const setup = (onSubmit = vi.fn(async () => {}), onCancel?: () => void) => {
  render(<KindleDeviceForm sender="library@lit.example.com" submitLabel="Add device" onSubmit={onSubmit} onCancel={onCancel} />);
  return onSubmit;
};
const name = () => screen.getByRole("textbox", { name: "Name" });
const email = () => screen.getByRole("textbox", { name: "Your Kindle email" });

describe("KindleDeviceForm", () => {
  it("submits a trimmed name and a lowercased address", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "  Scribe  ");
    await userEvent.type(email(), "  Me_X@Kindle.com ");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Scribe", "me_x@kindle.com"));
  });

  it("rejects a missing name without calling onSubmit", async () => {
    const onSubmit = setup();
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the device a name of 30 characters or fewer");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects a name over thirty characters", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "x".repeat(31));
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the device a name of 30 characters or fewer");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects an address that is not @kindle.com", async () => {
    const onSubmit = setup();
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "me@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your @kindle.com address");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a rejection from the server and keeps what was typed", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("You already have a device with that name"); });
    setup(onSubmit);
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a device with that name");
    expect(name()).toHaveValue("Scribe");
  });

  it("clears both fields after a successful submit", async () => {
    setup();
    await userEvent.type(name(), "Scribe");
    await userEvent.type(email(), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(name()).toHaveValue(""));
    expect(email()).toHaveValue("");
  });

  it("offers Cancel only when a handler is given", async () => {
    const onCancel = vi.fn();
    setup(vi.fn(async () => {}), onCancel);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/KindleDeviceForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Add to `web/src/kindle/limits.ts`:

```ts
export const MAX_LABEL = 30;
```

Create `web/src/components/KindleDeviceForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { KINDLE_ADDRESS_RE, KINDLE_HELP_URL, MAX_LABEL } from "../kindle/limits";

interface Props {
  sender: string;
  submitLabel: string;
  onSubmit(label: string, address: string): Promise<void>;
  onCancel?(): void;
  showHelp?: boolean;
}

// Shared by the book dialog (first send) and the Settings device list (add a device).
// Messages match the server's so a client-side and a server-side rejection read alike.
export default function KindleDeviceForm({ sender, submitLabel, onSubmit, onCancel, showHelp = true }: Props) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = label.trim();
    const email = address.trim().toLowerCase();
    if (!name || name.length > MAX_LABEL) { setError("Give the device a name of 30 characters or fewer"); return; }
    if (!KINDLE_ADDRESS_RE.test(email)) { setError("Enter your @kindle.com address"); return; }
    setError(undefined); setBusy(true);
    try {
      await onSubmit(name, email);
      setLabel(""); setAddress("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kindle-form" onSubmit={(e) => void submit(e)}>
      <label>Name
        <input type="text" value={label} disabled={busy} maxLength={MAX_LABEL} placeholder="Scribe" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>Your Kindle email
        <input type="email" value={address} disabled={busy} placeholder="name_123@kindle.com" onChange={(e) => setAddress(e.target.value)} />
      </label>
      {showHelp && (
        <p className="meta">
          <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Where do I find this?</a>{" "}
          Then add <code>{sender}</code> to your approved personal-document senders on that page.
        </p>
      )}
      {error && <div className="notif-error" role="alert">{error}</div>}
      <div className="suggest-form">
        <button type="submit" className="btn" disabled={busy}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/KindleDeviceForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/KindleDeviceForm.tsx web/src/components/KindleDeviceForm.test.tsx web/src/kindle/limits.ts
git commit -m "feat(web): shared name plus address device form"
```

---

### Task 9: Settings device manager

**Files:**
- Create: `web/src/components/DeviceList.tsx`, `web/src/components/DeviceList.test.tsx`
- Modify: `web/src/components/SettingsPage.tsx`, `web/src/components/SettingsPage.test.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `KindleDevice`, `DeviceInput` from Task 6; `useKindle` from Task 7; `KindleDeviceForm` from Task 8.
- Produces:
  ```ts
  interface Props {
    devices: KindleDevice[];
    defaultDeviceId: string | null;
    sender: string;
    onSave(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
  }
  export default function DeviceList(props: Props): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/DeviceList.test.tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KindleDevice } from "../kindle/api";
import DeviceList from "./DeviceList";

const TWO: KindleDevice[] = [
  { id: "a1", label: "Scribe", address: "a@kindle.com" },
  { id: "b2", label: "Phone", address: "b@kindle.com" },
];
const mount = (devices: KindleDevice[], defaultDeviceId: string | null, onSave = vi.fn(async () => {})) => {
  render(<DeviceList devices={devices} defaultDeviceId={defaultDeviceId} sender="library@lit.example.com" onSave={onSave} />);
  return onSave;
};
const row = (label: string) => screen.getByRole("listitem", { name: label });

describe("DeviceList", () => {
  it("lists devices and marks the default", () => {
    mount(TWO, "b2");
    expect(screen.getByRole("heading", { name: "Your devices" })).toBeInTheDocument();
    expect(within(row("Phone")).getByText("default")).toBeInTheDocument();
    expect(within(row("Scribe")).queryByText("default")).not.toBeInTheDocument();
    expect(within(row("Scribe")).getByText("a@kindle.com")).toBeInTheDocument();
  });

  it("prompts for a name on an unnamed migrated device", () => {
    mount([{ id: "a1", label: "", address: "me_x@kindle.com" }], "a1");
    expect(screen.getByPlaceholderText("Name this device")).toBeInTheDocument();
    expect(screen.getByText("Name this device so you can tell it apart")).toBeInTheDocument();
  });

  it("saves a rename when the field is left", async () => {
    const onSave = mount(TWO, "b2");
    const field = within(row("Scribe")).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Study Scribe");
    await userEvent.tab();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [{ id: "a1", label: "Study Scribe", address: "a@kindle.com" }, { id: "b2", label: "Phone", address: "b@kindle.com" }],
      "b2",
    ));
  });

  it("does not save when the name is unchanged", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("textbox"));
    await userEvent.tab();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reverts and explains when a rename is rejected", async () => {
    const onSave = vi.fn(async () => { throw new Error("You already have a device with that name"); });
    mount(TWO, "b2", onSave);
    const field = within(row("Scribe")).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Phone");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a device with that name");
    await waitFor(() => expect(field).toHaveValue("Scribe"));
  });

  it("makes another device the default", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [{ id: "a1", label: "Scribe", address: "a@kindle.com" }, { id: "b2", label: "Phone", address: "b@kindle.com" }],
      "a1",
    ));
  });

  it("removes a device", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.click(within(row("Scribe")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ id: "b2", label: "Phone", address: "b@kindle.com" }], "b2"));
  });

  it("adds a device through the form", async () => {
    const onSave = mount(TWO, "b2");
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Tablet");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "c@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      [...TWO, { label: "Tablet", address: "c@kindle.com" }],
      "b2",
    ));
  });

  it("hides the add form at the cap", () => {
    const five = Array.from({ length: 5 }, (_v, i) => ({ id: `i${i}`, label: `D${i}`, address: `d${i}@kindle.com` }));
    mount(five, "i0");
    expect(screen.queryByRole("button", { name: "Add device" })).not.toBeInTheDocument();
    expect(screen.getByText("You can save up to 5 devices")).toBeInTheDocument();
  });

  it("invites a first device when the list is empty", () => {
    mount([], null);
    expect(screen.getByRole("button", { name: "Add device" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
```

Update `web/src/components/SettingsPage.test.tsx`: its stub must answer `GET /api/kindle/devices` with a list and `PUT` with the canonical response. Keep the existing assertions on the heading, the sender, and the setup steps, and replace the address-field assertions with:

```tsx
  it("shows the saved devices and the sender", async () => {
    const fetchFn = vi.fn(async () => json(200, { devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1" })) as unknown as typeof fetch;
    mount(fetchFn);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your devices" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByText(/library@lit\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Personal Document Settings/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Scribe")).toBeInTheDocument();
  });

  it("shows a loading state before the list arrives", () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    mount(fetchFn);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/DeviceList.test.tsx src/components/SettingsPage.test.tsx`
Expected: FAIL — `DeviceList` does not exist.

- [ ] **Step 3: Write the implementation**

```tsx
// web/src/components/DeviceList.tsx
import { useState } from "react";
import type { DeviceInput, KindleDevice } from "../kindle/api";
import { MAX_DEVICES, MAX_LABEL } from "../kindle/limits";
import KindleDeviceForm from "./KindleDeviceForm";

interface Props {
  devices: KindleDevice[];
  defaultDeviceId: string | null;
  sender: string;
  onSave(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
}

const toInput = (d: KindleDevice): DeviceInput => ({ id: d.id, label: d.label, address: d.address });

export default function DeviceList({ devices, defaultDeviceId, sender, onSave }: Props) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Bumping this key remounts the rows, which discards a rejected rename draft.
  const [revision, setRevision] = useState(0);

  async function save(next: DeviceInput[], nextDefault?: string) {
    setError(undefined); setBusy(true);
    try {
      await onSave(next, nextDefault);
    } catch (e) {
      setError((e as Error).message);
      setRevision((r) => r + 1);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  const keptDefault = defaultDeviceId ?? undefined;

  async function rename(id: string, label: string) {
    await save(devices.map((d) => (d.id === id ? { ...toInput(d), label } : toInput(d))), keptDefault);
  }
  async function makeDefault(id: string) {
    await save(devices.map(toInput), id);
  }
  async function remove(id: string) {
    const next = devices.filter((d) => d.id !== id);
    await save(next.map(toInput), next.some((d) => d.id === defaultDeviceId) ? keptDefault : undefined);
  }
  async function add(label: string, address: string) {
    await save([...devices.map(toInput), { label, address }], keptDefault);
  }

  return (
    <div className="device-list">
      <h4>Your devices</h4>
      {devices.length > 0 && (
        <ul>
          {devices.map((d) => (
            <DeviceRow key={`${d.id}:${revision}`} device={d} isDefault={d.id === defaultDeviceId} busy={busy}
              onRename={(label) => rename(d.id, label)} onMakeDefault={() => makeDefault(d.id)} onRemove={() => remove(d.id)} />
          ))}
        </ul>
      )}
      {error && <div className="notif-error" role="alert">{error}</div>}
      {devices.length >= MAX_DEVICES
        ? <p className="meta">You can save up to {MAX_DEVICES} devices</p>
        : (
          <>
            <h4>Add a device</h4>
            <KindleDeviceForm sender={sender} submitLabel="Add device" showHelp={false} onSubmit={add} />
          </>
        )}
    </div>
  );
}

interface RowProps {
  device: KindleDevice;
  isDefault: boolean;
  busy: boolean;
  onRename(label: string): Promise<void>;
  onMakeDefault(): Promise<void>;
  onRemove(): Promise<void>;
}

function DeviceRow({ device, isDefault, busy, onRename, onMakeDefault, onRemove }: RowProps) {
  const [label, setLabel] = useState(device.label);
  const unnamed = device.label === "";

  function commit() {
    const next = label.trim();
    if (next === device.label) return;
    void onRename(next).catch(() => setLabel(device.label));
  }

  return (
    <li aria-label={device.label || device.address} className={unnamed ? "device unnamed" : "device"}>
      <input type="text" aria-label={`Name for ${device.address}`} value={label} disabled={busy} maxLength={MAX_LABEL}
        placeholder={unnamed ? "Name this device" : undefined}
        onChange={(e) => setLabel(e.target.value)} onBlur={commit} />
      <span className="meta">{device.address}</span>
      {isDefault ? <span className="chip">default</span>
        : <button type="button" className="more" disabled={busy} onClick={() => void onMakeDefault()}>Make default</button>}
      <button type="button" className="more" disabled={busy} onClick={() => void onRemove()}>Remove</button>
      {unnamed && <p className="meta">Name this device so you can tell it apart</p>}
    </li>
  );
}
```

Add `export const MAX_DEVICES = 5;` to `web/src/kindle/limits.ts`.

Rewrite `web/src/components/SettingsPage.tsx`:

```tsx
import { useKindle } from "../kindle/KindleProvider";
import { KINDLE_HELP_URL } from "../kindle/limits";
import DeviceList from "./DeviceList";

export default function SettingsPage() {
  const kindle = useKindle();

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
        {kindle.devices === undefined
          ? <p className="empty">Loading…</p>
          : <DeviceList devices={kindle.devices} defaultDeviceId={kindle.defaultDeviceId} sender={kindle.sender} onSave={kindle.save} />}
      </section>
    </main>
  );
}
```

Append to `web/src/styles.css`:

```css
.device-list ul { list-style: none; margin: 0 0 1rem; padding: 0; }
.device-list li.device { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding: 0.4rem 0; border-bottom: 1px solid var(--line); }
.device-list li.device input { min-width: 10rem; }
.device-list li.unnamed input { border-color: var(--accent, #b58900); }
.device-list h4 { margin: 0.75rem 0 0.35rem; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/DeviceList.test.tsx src/components/SettingsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/DeviceList.tsx web/src/components/DeviceList.test.tsx web/src/components/SettingsPage.tsx web/src/components/SettingsPage.test.tsx web/src/kindle/limits.ts web/src/styles.css
git commit -m "feat(web): manage Kindle devices from Settings"
```

---

### Task 10: Split button in the book dialog

**Files:**
- Create: `web/src/components/SendToKindleButton.tsx`, `web/src/components/SendToKindleButton.test.tsx`
- Modify: `web/src/components/BookDetail.tsx`, `web/src/components/BookDetail.test.tsx`, `web/src/components/Library.tsx`, `web/src/components/Library.test.tsx`, `web/src/styles.css`
- Delete: `web/src/components/KindleAddressForm.tsx`, `web/src/components/KindleAddressForm.test.tsx`

**Interfaces:**
- Consumes: `KindleDevice` from Task 6; `KindleDeviceForm` from Task 8.
- Produces:
  ```ts
  interface Props {
    devices: KindleDevice[];
    defaultDeviceId: string | null;
    pdf?: boolean;              // renders "Send PDF to …"
    disabled: boolean;
    title?: string;
    sending: boolean;
    onSend(deviceId?: string): void;
  }
  export default function SendToKindleButton(props: Props): JSX.Element;
  ```
  `BookDetail`'s `kindle` prop becomes
  ```ts
  {
    devices: KindleDevice[] | undefined;
    defaultDeviceId: string | null;
    sender: string;
    onSend(book: Book, format?: "epub" | "pdf", deviceId?: string): Promise<void>;
    onSaveDevice(label: string, address: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/SendToKindleButton.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KindleDevice } from "../kindle/api";
import SendToKindleButton from "./SendToKindleButton";

const TWO: KindleDevice[] = [
  { id: "a1", label: "Scribe", address: "a@kindle.com" },
  { id: "b2", label: "Phone", address: "b@kindle.com" },
];
const mount = (devices: KindleDevice[], defaultDeviceId: string | null, extra: Partial<Parameters<typeof SendToKindleButton>[0]> = {}) => {
  const onSend = vi.fn();
  render(<SendToKindleButton devices={devices} defaultDeviceId={defaultDeviceId} disabled={false} sending={false} onSend={onSend} {...extra} />);
  return onSend;
};

describe("SendToKindleButton", () => {
  it("names the only device and offers no menu", async () => {
    const onSend = mount([TWO[0]], "a1");
    expect(screen.queryByRole("button", { name: "Choose a device" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to Scribe" }));
    expect(onSend).toHaveBeenCalledWith("a1");
  });

  it("says Send to Kindle when there are no devices or the one device is unnamed", () => {
    mount([], null);
    expect(screen.getByRole("button", { name: "Send to Kindle" })).toBeInTheDocument();
    render(<SendToKindleButton devices={[{ id: "z", label: "", address: "z@kindle.com" }]} defaultDeviceId="z" disabled={false} sending={false} onSend={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Send to Kindle" })).toHaveLength(2);
  });

  it("sends to the default from the main half and names it", async () => {
    const onSend = mount(TWO, "b2");
    await userEvent.click(screen.getByRole("button", { name: "Send to Phone" }));
    expect(onSend).toHaveBeenCalledWith("b2");
  });

  it("opens the menu, marks the default, and sends to the chosen device", async () => {
    const onSend = mount(TWO, "b2");
    const caret = screen.getByRole("button", { name: "Choose a device" });
    expect(caret).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Phone" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitem", { name: "Scribe" }));
    expect(onSend).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("closes the menu on Escape without sending", async () => {
    const onSend = mount(TWO, "b2");
    await userEvent.click(screen.getByRole("button", { name: "Choose a device" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the sending state and hides the caret while a send is in flight", () => {
    mount(TWO, "b2", { sending: true });
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Choose a device" })).not.toBeInTheDocument();
  });

  it("renders the PDF wording and honours disabled with a tooltip", () => {
    mount(TWO, "b2", { pdf: true, disabled: true, title: "Too large for Kindle delivery — download instead" });
    const btn = screen.getByRole("button", { name: "Send PDF to Phone" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Too large for Kindle delivery — download instead");
  });
});
```

Add to `web/src/components/BookDetail.test.tsx` (adjusting the file's existing `kindle` stub to the new shape):

```tsx
  it("opens the two-field form when no device is saved, then saves and sends", async () => {
    const onSaveDevice = vi.fn(async () => {});
    const onSend = vi.fn(async () => {});
    renderDetail({ devices: [], defaultDeviceId: null, sender: "library@lit.example.com", onSend, onSaveDevice });
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Scribe");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSaveDevice.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]);
    expect(onSaveDevice).toHaveBeenCalledWith("Scribe", "a@kindle.com");
  });

  it("remembers the requested format across the form: PDF stays PDF", async () => {
    const onSend = vi.fn(async () => {});
    renderDetail({ devices: [], defaultDeviceId: null, sender: "s@x.com", onSend, onSaveDevice: vi.fn(async () => {}) });
    await userEvent.click(screen.getByRole("button", { name: "Send PDF to Kindle" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Scribe");
    await userEvent.type(screen.getByRole("textbox", { name: "Your Kindle email" }), "a@kindle.com");
    await userEvent.click(screen.getByRole("button", { name: "Save and send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.anything(), "pdf", undefined));
  });

  it("passes the chosen device through to onSend", async () => {
    const onSend = vi.fn(async () => {});
    renderDetail({
      devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }, { id: "b2", label: "Phone", address: "b@kindle.com" }],
      defaultDeviceId: "a1", sender: "s@x.com", onSend, onSaveDevice: vi.fn(async () => {}),
    });
    await userEvent.click(screen.getByRole("button", { name: "Choose a device" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Phone" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.anything(), "epub", "b2"));
  });

  it("reopens the form when the server says the device list is empty", async () => {
    const onSend = vi.fn(async () => { throw Object.assign(new Error("no"), { code: "no_address" }); });
    renderDetail({ devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }], defaultDeviceId: "a1", sender: "s@x.com", onSend, onSaveDevice: vi.fn(async () => {}) });
    await userEvent.click(screen.getByRole("button", { name: "Send to Scribe" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });
```

Update `web/src/components/Library.test.tsx`'s Kindle assertions to expect the label-based toast. Replace the existing success-toast test with these two, keeping the file's own render helper and Kindle state stub:

```tsx
  it("names the device in the success toast", async () => {
    const kindle = kindleStub({ send: async () => ({ sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "Scribe" }) });
    renderLibrary({ kindle });
    await openFirstBook();
    await userEvent.click(screen.getByRole("button", { name: /^Send to / }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent to Scribe — it usually arrives within a couple of minutes");
  });

  it("falls back to the address when the device has no name yet", async () => {
    const kindle = kindleStub({
      devices: [{ id: "a1", label: "", address: "a@kindle.com" }],
      send: async () => ({ sentTo: "a@kindle.com", format: "epub", deviceId: "a1", deviceLabel: "" }),
    });
    renderLibrary({ kindle });
    await openFirstBook();
    await userEvent.click(screen.getByRole("button", { name: "Send to Kindle" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent to a@kindle.com — it usually arrives within a couple of minutes");
  });

  it("does not toast a no_address rejection, so the dialog can open the form", async () => {
    const kindle = kindleStub({ send: async () => { throw Object.assign(new Error("no"), { code: "no_address", name: "KindleError" }); } });
    renderLibrary({ kindle });
    await openFirstBook();
    await userEvent.click(screen.getByRole("button", { name: /^Send to / }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
```

`kindleStub` is the file's existing helper for the `KindleState` object; extend it so it defaults to `devices: [{ id: "a1", label: "Scribe", address: "a@kindle.com" }]`, `defaultDeviceId: "a1"`, and a `save` that resolves, with each field overridable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/SendToKindleButton.test.tsx src/components/BookDetail.test.tsx src/components/Library.test.tsx`
Expected: FAIL — the button module does not exist and the dialog still uses the address form.

- [ ] **Step 3: Write the implementation**

```tsx
// web/src/components/SendToKindleButton.tsx
import { useEffect, useRef, useState } from "react";
import type { KindleDevice } from "../kindle/api";

interface Props {
  devices: KindleDevice[];
  defaultDeviceId: string | null;
  pdf?: boolean;
  disabled: boolean;
  title?: string;
  sending: boolean;
  onSend(deviceId?: string): void;
}

// One device (or none) renders a plain button; two or more render a split button whose
// caret opens the device menu. A pick applies to that click only — no sticky selection.
export default function SendToKindleButton({ devices, defaultDeviceId, pdf = false, disabled, title, sending, onSend }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);

  const target = devices.find((d) => d.id === defaultDeviceId) ?? devices[0];
  const verb = pdf ? "Send PDF to" : "Send to";
  const mainLabel = sending ? "Sending…" : `${verb} ${target?.label || "Kindle"}`;

  return (
    <div className="kindle-send" ref={wrap}>
      <button className={pdf ? "more" : "btn secondary"} disabled={disabled || sending} title={title}
        onClick={() => onSend(target?.id)}>
        {mainLabel}
      </button>
      {devices.length > 1 && !sending && (
        <>
          <button type="button" className="caret" aria-label="Choose a device" aria-haspopup="menu" aria-expanded={open}
            disabled={disabled} onClick={() => setOpen((v) => !v)}>▾</button>
          {open && (
            <div className="kindle-menu" role="menu">
              {devices.map((d) => (
                <button key={d.id} type="button" role="menuitem" aria-checked={d.id === (target?.id ?? null)}
                  onClick={() => { setOpen(false); onSend(d.id); }}>
                  {d.label || d.address}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

In `BookDetail.tsx`, widen the `kindle` prop as shown in Interfaces, then replace the Kindle block. The state keeps the discriminated union that already carries the requested format:

```tsx
  async function sendToKindle(format: "epub" | "pdf", deviceId?: string) {
    if (!kindle) return;
    // undefined covers the GET /api/kindle/devices window still in flight; treat it the
    // same as an empty list so a click during that window opens the form instead of 409ing.
    if (!kindle.devices || kindle.devices.length === 0) { setKindleState({ kind: "form", format }); return; }
    setKindleState({ kind: "sending" });
    try {
      await kindle.onSend(book!, format, deviceId);
      setKindleState({ kind: "idle" });
    } catch (e) {
      setKindleState((e as { code?: string }).code === "no_address" ? { kind: "form", format } : { kind: "idle" });
    }
  }
```

and the rendered block:

```tsx
          {kindle && (() => {
            const primary = kindleFormat(book);
            if (!primary) return null;
            const pdf = primary.type === "epub" ? kindleFormat(book, "pdf") : undefined;
            const tooLarge = primary.size > KINDLE_MAX_BYTES;
            const sending = kindleState.kind === "sending";
            const devices = kindle.devices ?? [];
            return (
              <div className="kindle">
                {kindleState.kind === "form" ? (
                  <KindleDeviceForm sender={kindle.sender} submitLabel="Save and send"
                    onSubmit={async (label, address) => {
                      const format = kindleState.format;
                      await kindle.onSaveDevice(label, address);
                      setKindleState({ kind: "sending" });
                      try { await kindle.onSend(book!, format); } finally { setKindleState({ kind: "idle" }); }
                    }}
                    onCancel={() => setKindleState({ kind: "idle" })} />
                ) : (
                  <>
                    <SendToKindleButton devices={devices} defaultDeviceId={kindle.defaultDeviceId}
                      disabled={busy || tooLarge} sending={sending}
                      title={tooLarge ? "Too large for Kindle delivery — download instead" : undefined}
                      onSend={(deviceId) => void sendToKindle(primary.type as "epub" | "pdf", deviceId)} />
                    {pdf && !sending && (
                      <SendToKindleButton devices={devices} defaultDeviceId={kindle.defaultDeviceId} pdf
                        disabled={busy || pdf.size > KINDLE_MAX_BYTES} sending={false}
                        title={pdf.size > KINDLE_MAX_BYTES ? "Too large for Kindle delivery — download instead" : undefined}
                        onSend={(deviceId) => void sendToKindle("pdf", deviceId)} />
                    )}
                  </>
                )}
              </div>
            );
          })()}
```

Swap the import of `KindleAddressForm` for `KindleDeviceForm` and add the button import.

In `Library.tsx`, rebuild `kindleForDialog`:

```tsx
  const kindleForDialog = useMemo(() => kindle && {
    devices: kindle.devices,
    defaultDeviceId: kindle.defaultDeviceId,
    sender: kindle.sender,
    onSend: async (book: Book, format?: "epub" | "pdf", deviceId?: string) => {
      try {
        const r = await kindle.send(book.id, format, deviceId);
        ok(`Sent to ${r.deviceLabel || r.sentTo} — it usually arrives within a couple of minutes`);
      } catch (e) {
        if ((e as KindleError).code !== "no_address") fail((e as Error).message);
        throw e;
      }
    },
    onSaveDevice: async (label: string, address: string) => {
      try { await kindle.save([...(kindle.devices ?? []), { label, address }]); }
      catch (e) { fail((e as Error).message); throw e; }
    },
  }, [kindle, ok, fail]);
```

Append to `web/src/styles.css`:

```css
.kindle-send { position: relative; display: inline-flex; align-items: stretch; }
.kindle-send .caret { border: 1px solid var(--line); border-left: 0; background: none; cursor: pointer; padding: 0 0.5rem; color: inherit; }
.kindle-send .caret[disabled] { opacity: 0.5; cursor: default; }
.kindle-menu { position: absolute; top: 100%; right: 0; z-index: 5; min-width: 10rem; display: flex; flex-direction: column;
  background: var(--panel, #fff); border: 1px solid var(--line); border-radius: 4px; box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); }
.kindle-menu button { text-align: left; padding: 0.4rem 0.6rem; border: 0; background: none; cursor: pointer; color: inherit; }
.kindle-menu button:hover { background: var(--hover, rgb(0 0 0 / 0.06)); }
.kindle-menu button[aria-checked="true"]::after { content: " ✓"; }
```

Delete `web/src/components/KindleAddressForm.tsx` and `web/src/components/KindleAddressForm.test.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS, typecheck clean, build succeeds. The whole web suite should be green again at this point.

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web): pick a Kindle device from the book dialog"
```

---

### Task 11: Bounce rows name the device

**Files:**
- Modify: `web/src/notifications/render.ts`, `web/src/components/NotificationItem.tsx`, `web/src/components/NotificationBell.tsx`, `web/src/components/NotificationsPage.tsx`, `web/src/App.tsx`
- Test: `web/src/notifications/render.test.ts`, `web/src/components/NotificationItem.test.tsx`

**Interfaces:**
- Consumes: the `deviceId` payload field from Task 5; `KindleState.devices` from Task 7.
- Produces: `RenderContext` gains `deviceLabelOf?(deviceId: string): string | undefined`; `NotificationItem`, `NotificationBell`, and `NotificationsPage` each gain an optional `deviceLabelOf` prop; `Shell` supplies it from the loaded device list.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/notifications/render.test.ts`:

```ts
  it("kindle_bounce names the device when it is still saved", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com", deviceLabelOf: (id: string) => (id === "a1" ? "Scribe" : undefined) };
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "a1" }), ctx2))
      .toEqual({ icon: "📵", text: 'Scribe rejected "Black Hound of Death" — add library@lit.example.com to your approved senders', href: "/settings" });
  });

  it("kindle_bounce falls back when the device is gone or was never recorded", () => {
    const ctx2 = { ...ctx, sender: "library@lit.example.com", deviceLabelOf: () => undefined };
    const expected = 'Your Kindle rejected "Black Hound of Death" — add library@lit.example.com to your approved senders';
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "gone" }), ctx2).text).toBe(expected);
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x" }), ctx2).text).toBe(expected);
    expect(renderNotification(mk("kindle_bounce", { bookId: "b1", kind: "Bounce", reason: "x", deviceId: "a1" }), { ...ctx, sender: "library@lit.example.com" }).text).toBe(expected);
  });
```

Add to `web/src/components/NotificationItem.test.tsx`:

```tsx
  it("names the device on a kindle_bounce row", () => {
    render(
      <NotificationItem
        n={{ id: "n1", type: "kindle_bounce", createdAt: new Date().toISOString(), read: false,
             payload: { bookId: "b1", kind: "Bounce", reason: "Permanent/General", deviceId: "a1" } }}
        titleOf={() => "Black Hound of Death"}
        sender="library@lit.example.com"
        deviceLabelOf={(id) => (id === "a1" ? "Scribe" : undefined)}
        onResolve={vi.fn()} />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent('Scribe rejected "Black Hound of Death" — add library@lit.example.com to your approved senders');
    expect(link).toHaveAttribute("href", "/settings");
  });
```

Match the prop names and the notification fixture shape the rest of that file already uses; if its helper builds notifications, use the helper instead of the literal above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/notifications/render.test.ts src/components/NotificationItem.test.tsx`
Expected: FAIL — the row still starts with "Your Kindle".

- [ ] **Step 3: Write the implementation**

In `web/src/notifications/render.ts`:

```ts
export interface RenderContext {
  titleOf(bookId: string): string | undefined;
  sender?: string;
  deviceLabelOf?(deviceId: string): string | undefined;
}
```

and the entry:

```ts
  kindle_bounce: (p, ctx) => {
    const title = typeof p.bookId === "string" ? ctx.titleOf(p.bookId) : undefined;
    const label = typeof p.deviceId === "string" && p.deviceId ? ctx.deviceLabelOf?.(p.deviceId) : undefined;
    const who = label || "Your Kindle";
    return {
      icon: "📵",
      text: `${who} rejected "${title ?? "a book"}" — add ${ctx.sender ?? "the library address"} to your approved senders`,
      href: "/settings",
    };
  },
```

Thread `deviceLabelOf?: (deviceId: string) => string | undefined` through `NotificationItem` (into the `renderNotification` context alongside `titleOf` and `sender`), then through `NotificationBell` and `NotificationsPage` exactly as `sender` is threaded today.

In `App.tsx`'s `Shell`, build the lookup from the loaded list and pass it to both:

```tsx
  const deviceLabelOf = useCallback(
    (id: string) => kindle.devices?.find((d) => d.id === id)?.label || undefined,
    [kindle.devices],
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS, typecheck clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/notifications/render.ts web/src/notifications/render.test.ts web/src/components/NotificationItem.tsx web/src/components/NotificationItem.test.tsx web/src/components/NotificationBell.tsx web/src/components/NotificationsPage.tsx web/src/App.tsx
git commit -m "feat(web): bounce rows name the device that rejected the book"
```

---

### Task 12: Documentation and backlog

**Files:**
- Modify: `README.md`, `infra/README.md`, `BACKLOG.md`

**Interfaces:**
- Consumes: nothing. Documents Tasks 1 to 11.

- [ ] **Step 1: Update the README**

Replace the existing Send to Kindle bullet under "What it does" with:

```markdown
- **Send to Kindle.** One click emails the EPUB (or PDF) to a saved `@kindle.com`
  address through Amazon SES, up to 28 MB. Save several devices, pick one per send,
  and a bounce turns into a notification naming the device that rejected it. Sends
  happen synchronously in one Lambda, which is right for a handful of readers — if
  volume ever grows, the upgrade path is an SQS queue and a worker Lambda.
```

Update the three per-package test counts in the Repository layout table to the numbers the suites actually report after Task 11. Run each suite and read the totals rather than guessing.

- [ ] **Step 2: Update the infra README**

In the "Send to Kindle (SES)" section, replace the sentence describing the single address with:

```markdown
Each reader saves up to five devices under `/settings`, one per Amazon
`@kindle.com` address, and marks one the default. The address that was saved
before devices existed is migrated on first read and shows up asking to be named.
```

In the "Reviewing events" section, note that `kindle.sent`, `kindle.send_failed`,
and `kindle.bounce` now carry a `deviceId` field.

- [ ] **Step 3: Move backlog #25 to Done**

Remove row 25 from "Product polish" and add it to the Done table, matching the column layout of the rows already there:

```markdown
| 25 | **Multiple Kindle devices per user.** | Named device list (up to 5) with a default, split-button send with a device menu, bounce rows naming the device, lazy migration of the single saved address. `infra/lambda/kindle/devices.ts`, `web/src/components/DeviceList.tsx`, `web/src/components/SendToKindleButton.tsx`; spec and plan `2026-09-06-kindle-devices`. |
```

Read the Done table first and reorder the cells if its columns differ.

- [ ] **Step 4: Check nothing else names the old routes**

Run: `git grep -n "kindle/address\|kindleAddress\|KindleAddressForm"`
Expected: no hits outside `docs/superpowers/` (the older spec and plan describe the previous design and stay as written).

- [ ] **Step 5: Commit**

```bash
git add README.md infra/README.md BACKLOG.md
git commit -m "docs: multiple Kindle devices"
```

---

### Task 13: Deploy and smoke test (controller; needs AWS credentials and Jay)

- [ ] **Step 1**: `cd infra && npx cdk diff`. Expect: two routes replaced (`GET`/`PUT /api/kindle/address` removed, `GET`/`PUT /api/kindle/devices` added), in-place code updates on the `kindle` and `kindle-events` Lambdas, no other resource added, removed, or replaced.
- [ ] **Step 2**: `npm run deploy`, then `python3 ../scripts/apply-outputs.py`.
- [ ] **Step 3**: `scripts/deploy-web.sh`.
- [ ] **Step 4** (Jay): open `/settings`. The existing device appears unnamed with the prompt; name it `Scribe`. Add a second device. Open a small book and confirm the split button, the menu, and that the toast names the device.
- [ ] **Step 5** (Jay): send to the second device and confirm arrival, or confirm a bounce row naming that device if its sender is not approved.
- [ ] **Step 6**: `scripts/backup.sh`.

---
