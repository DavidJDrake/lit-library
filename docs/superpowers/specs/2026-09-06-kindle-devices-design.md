# Multiple Kindle Devices — Design Spec

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan
**Backlog:** #25
**Builds on:** `2026-09-05-send-to-kindle-design.md` (settings row, send handler,
bounce path, renderer entry) and `2026-09-05-notifications-design.md` (fan-out,
`RenderContext`).

## Purpose

Amazon issues one `@kindle.com` address per device. A reader with a Scribe, a
Paperwhite, and the phone app has three, and today the library holds only one.
This spec replaces the single stored address with a named device list, adds a
default, lets the reader pick a target at send time, and makes a bounce name the
device that rejected the book.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Send UX with 2+ devices | **Split button**: the main half sends to the default and names it; a caret opens the device list with the default checked. The pick applies to that click only; no sticky state. |
| Device naming | **Required label plus address.** Labels are how the button and the menu read. |
| Existing saved address | **Prompt to name it.** It migrates to a one-device list with an empty label, marked default; Settings highlights it with a "Name this device" field. Sending keeps working while it is unnamed. |
| Device list API | **Read and replace whole** (`GET`/`PUT /api/kindle/devices`), not a route per operation. Rename, add, remove, reorder, and change-default are one code path. |
| Device cap | 5 per user. |
| Bounce naming | The outgoing message carries a `deviceId` tag; the notification stores the id; the **web renderer** resolves it to a label from the already-loaded device list. No new IAM grant, no extra read in the bounce path. |
| Out of scope | Sending to several devices in one click; per-device format preference; discovering devices from Amazon (no interface exists); a backfill migration script. |

## Data model

Settings row keeps its key: `pk = USER#<email>`, `sk = SETTINGS`. Body becomes:

```jsonc
{
  "devices": [
    { "id": "a3f19c2b", "label": "Scribe", "address": "me_emwzq2@kindle.com", "addedAt": "2026-09-06T18:31:41.000Z" }
  ],
  "defaultDeviceId": "a3f19c2b",
  "updatedAt": "2026-09-06T18:31:41.000Z"
}
```

- `id`: 8 lowercase hex characters, generated server-side on add. The alphabet is
  chosen so the id can be used verbatim as an SES tag value (`[A-Za-z0-9_-]`
  only), unlike an email address, which must be hex-encoded.
- `label`: required on save, trimmed, 1–30 characters, unique per user
  case-insensitively. The empty string is reserved for the migrated device and
  can never be written by a client.
- `address`: today's rule unchanged — `^[A-Za-z0-9._+-]+@kindle\.com$`,
  case-insensitive, stored lowercased. Unique per user.
- `defaultDeviceId`: must name a device present in `devices`. A list of exactly
  one device is normalised before validation: that device becomes the default
  whatever the client sent, so a single-device save can never fail on the
  default.

### Lazy migration

A row holding `kindleAddress` and no `devices` is **read** as:

```jsonc
{ "devices": [{ "id": <derived>, "label": "", "address": <kindleAddress>, "addedAt": <updatedAt> }],
  "defaultDeviceId": <derived> }
```

The derived id is the first 8 hex characters of the SHA-256 of the address, so it
is stable across reads without a write, and a client that reads it and sends it
straight back on a `PUT` is treated as naming an existing device rather than an
unknown one. The row is rewritten in the new shape on
the first `PUT`. No backfill script, no dual-write window. A row with neither
field reads as an empty list.

## API

All three routes sit on the existing HTTP API behind the default JWT authorizer,
served by the existing `kindle` Lambda. The two address routes are **replaced**,
so the route count is unchanged apart from `send`.

### `GET /api/kindle/devices`

`200 { devices: [{ id, label, address }], defaultDeviceId }`. `addedAt` is not
returned; the client has no use for it. An empty list returns
`{ devices: [], defaultDeviceId: null }`.

### `PUT /api/kindle/devices`

Body `{ devices: [{ id?, label, address }], defaultDeviceId? }`. Entries without
an `id` are new and are assigned one. Entries with an `id` not present in the
stored row are rejected rather than silently created, so a stale client cannot
resurrect a removed device. Returns `200` with the canonical list in the same
shape as `GET`, which is the client's source of truth for newly assigned ids.

Errors are JSON `{ error, message? }`:

| Status | `error` | When |
|---|---|---|
| 400 | `bad_label` | Missing, blank after trim, over 30 characters, or duplicated within the list |
| 400 | `bad_address` | Fails the address rule, or duplicated within the list |
| 400 | `too_many` | More than 5 devices |
| 400 | `bad_default` | `defaultDeviceId` names no device in the list |
| 400 | `unknown_device` | An entry carries an `id` that is not in the stored row |
| 400 | `bad_request` | The same `id` appears twice in one submission (`Send each device once`) |

Sending an empty list is valid and clears the setting, matching today's behavior
when the address is cleared.

### `POST /api/kindle/send`

Body gains an optional `deviceId`. Omitted means the default. All existing
statuses are unchanged, including `409 no_address` when the list is empty, which
is what triggers the inline form. One status is added:

| Status | `error` | When |
|---|---|---|
| 400 | `unknown_device` | `deviceId` names no device the user has |

`202` body becomes `{ sentTo, format, deviceId, deviceLabel }`. `sentTo` remains
the address for continuity. `deviceLabel` is the empty string for a migrated
device that has not been named yet, and the toast falls back to the address in
that case, which is today's wording exactly.

The outgoing message gains a third SES tag, `deviceId`, alongside the existing
`recipient` and `bookId`. Its value is the id verbatim, no encoding.

## Bounce path

`kindle-events` reads the `deviceId` tag when present and includes it in the
`kindle_bounce` notification payload and in the `kindle.bounce` log event. It
does **not** resolve the label; it has no access to the settings row and gains
none.

`RenderContext` gains `deviceLabelOf(deviceId): string | undefined`, mirroring the
existing `titleOf`. `Shell` supplies it from the loaded device list. The renderer
entry becomes:

- Known device: `Scribe rejected "<title>" — add <sender> to your approved senders`
- Unknown or missing device: `Your Kindle rejected "<title>" — add <sender> to your approved senders`

The second string is today's text unchanged, so an old notification stored before
this feature renders exactly as it does now.

## Web

### `KindleProvider`

```ts
interface KindleDevice { id: string; label: string; address: string }
interface KindleState {
  devices: KindleDevice[] | undefined;   // undefined while loading
  defaultDeviceId: string | null;
  sender: string;
  save(devices: Array<{ id?: string; label: string; address: string }>, defaultDeviceId?: string): Promise<void>;
  send(bookId: string, format?: string, deviceId?: string): Promise<{ sentTo: string; format: string; deviceLabel: string }>;
}
```

`save` replaces the whole list and stores the canonical response, so ids assigned
by the server are available immediately.

### Settings page

Section heading stays `Send to Kindle`. Under it:

- Heading `Your devices`, then one row per device: label, address, a `default`
  marker on the default, and the actions `Make default` and `Remove`. The label
  is an editable field; leaving the field saves when the value changed and is
  valid, and reverts with an inline error when it is not.
- A device whose label is empty renders its field with the placeholder
  `Name this device` and a hint `Name this device so you can tell it apart`. The
  row is visually marked as needing attention.
- Below the list, `Add a device` with fields `Name` and `Your Kindle email` and a
  button `Add device`. It omits the "Where do I find this?" help link, because the
  one-time-setup steps directly above already link the same Amazon page. The button is disabled at 5 devices, with the note
  `You can save up to 5 devices`.
- The existing one-time-setup steps and the approved-sender instruction stay as
  they are.

### Book dialog

| Devices | Rendering |
|---|---|
| 0 | Today's inline form, now with a `Name` field above the address; button `Save and send` |
| 1 | Plain button `Send to <label>`; unnamed migrated device reads `Send to Kindle` |
| 2+ | Split button: main half `Send to <default label>`, caret button labelled `Choose a device`, menu listing every device with the default checked |

The sending state, the oversize tooltip, and the disabled behavior are unchanged.
When a book offers a PDF as well, that second button gets the same caret and the
same menu; the two buttons do not share a selection.

Success toast: `Sent to <label> — it usually arrives within a couple of minutes`.

## Testing

**Lambda:** store round-trip in the new shape; reading a legacy single-address row;
reading a row with neither field; each `PUT` validation branch; the one-device
default override; send with an explicit device, without one, and with a stale one;
the `deviceId` tag reaching the message; `202` body carrying the label.

**Bounce:** a record with a `deviceId` tag carries it into the notification payload
and the log event; a record without one still works.

**Web:** provider load, save, and id reconciliation; Settings rename, make default,
remove, add, cap, and the unnamed-device prompt; the three book-dialog states; the
menu sending the chosen device; the renderer's known and unknown label paths.

All suites stay offline.

## Rollout

1. `cdk deploy` — Lambda code and two replaced routes. No new AWS resources.
2. `scripts/deploy-web.sh`.
3. Open Settings, name the migrated device, add a second, send to each.

A browser holding the previous page in memory across the deploy calls a route that
no longer exists and shows the add-device form until reloaded. The entry document
is served uncached, so a reload corrects it. Acceptable for a private library with
a handful of readers.
