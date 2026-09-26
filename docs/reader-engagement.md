# Reader engagement: groundwork for epic 31

Epic 31's own first step is to ask the two other readers what would bring them
back, before building anything. This document is the groundwork for that
conversation, plus a costed look at the three candidate features so the
answers can be turned into a build order quickly.

## 1. What we actually know

From the counts already in `BACKLOG.md` (three accounts, nine downloads total
across two readers, one reader with any reading-status rows, Kindle device, or
OPDS token) and from how that data is recorded (`infra/lambda/library/store.ts`,
`infra/lambda/library/downloads.ts`):

- **Downloads are tracked per reader, keyed by email, one row per book.**
  `DynamoDownloadsStore.listDownloadedBookIds` queries by `email` and returns
  distinct book ids — a reader downloading the same book via direct download
  and via Kindle send would still only show one id. We cannot tell *when* a
  download happened from this table alone (no timestamp is read here), only
  that it happened at least once, so we cannot show a trend like "downloads
  per month" without going back to the raw rows.
- **Reading status is opt-in and per-work, not per-view.** `ReadingStatus` is
  `"want to read" | "reading" | "finished"`, set explicitly by the reader
  through the UI (`Library.tsx`'s `changeStatus`). Nobody using the site
  without ever touching that control leaves zero trace — it is not a proxy
  for "did they browse."
- **There is no read/visit/session log.** Nothing in `infra/lambda/library` or
  `infra/lambda/notifications` records a page view, a search query, or a
  login. The `notifications` table records in-app notification rows (read/
  unread) but that only tells us who has *ever* opened the notifications
  panel, not when, and not whether they read the underlying item.
- **Two readers have never done anything durable.** No download row, no
  reading-status row, no Kindle device, no OPDS token for either. That is
  consistent with several different stories — never opened the link, opened
  it once and didn't find anything, or read things without ever clicking
  "download" (e.g. read in-browser, if that's possible, or just browsed) —
  and the data cannot distinguish between them.

**What this data can answer:** whether a reader has ever taken one of a small
set of deliberate actions (download, Kindle send, status change, OPDS setup).

**What it cannot answer:** whether they visited and left empty-handed, what
they were looking for, whether the catalog matched their taste, or whether
the *notification itself* ever reached them (it's in-app only — see epic 31's
"why" — so a reader who never logs in never sees it, and we have no signal to
tell "never told" apart from "told and not interested").

Nine downloads across two readers, with no timestamps or session context, is
not a trend — it is a few data points. Any interpretation beyond "these two
people have engaged least" would be invented.

## 2. Questions to ask the two readers

Short, open, aimed at what would change the build — not at defending features
already picked.

1. When's the last time you thought "I wonder if anything new got added" — what did you do next, if anything?
2. If we emailed you when new books show up, would you actually want that, or would it just be more inbox to manage? How often would feel right — every new book, a weekly roundup, something else?
3. When you've opened the library, what made you leave? Not enough of a nudge on where to start, too much to search through, wrong kind of books, or something else entirely?
4. Is there a category or author you'd want to know about specifically (e.g. new TTRPG books, new Lovecraft-circle additions) rather than everything?
5. Is there anything about *how* you'd read this (email vs. checking a site, phone vs. desktop) that we're getting wrong?

Kept to five so they're easy to answer in one message; question 2 is the one
that most directly tests the digest email, question 3 tests the non-search
entry point, and question 1 tests whether either feature is solving a real
problem versus one we assumed.

## 3. The three candidate features, costed

### Email digest of new books

**What it does:** on publish, email each reader (or opted-in readers) a
summary of newly added books, instead of only writing an in-app notification.

**Reuses:**
- The fan-out primitive (`infra/lambda/notifications/fanout.ts`'s `notify`),
  which already resolves `"everyone"` via Cognito and writes one row per
  recipient — the recipient-resolution and dedup logic needs no changes.
- The existing trigger: `scripts/notify-books-added.py` already computes
  "new since last publish" (new editions only, capped at 20 ids) and invokes
  the notifications Lambda with that payload after every publish. A digest
  would piggyback on the same invocation rather than adding a new trigger.
- The verified SES domain identity and configuration set in `infra/lib/kindle.ts`
  (`ses.EmailIdentity`, DKIM-signed, with a bounce/complaint SNS topic already
  wired up) — sending mail from the site domain requires no new infra
  identity, only a new send path using it.

**Roughly what it takes:** a template (probably just title/author/cover-link
per new book, capped like the in-app one already is), an SES `SendEmail` call
added to the notify path (gated on an opt-in flag, see below), and something
that turns "N books added" into readable content — the current payload
(`{count, bookIds}`) doesn't carry titles/authors, so the digest would need to
either fetch book metadata Lambda-side or have the caller pass richer data.

**What could go wrong:**
- Emailing someone who never asked for it is the sharpest risk named in the
  epic itself — this is why item 4 (preferences/unsubscribe) has to exist
  before or alongside this, not after.
- A hard bounce or complaint on a broadcast send is different from the
  existing Kindle-send bounce handling (`infra/lambda/kindle-events/`), which
  is one-to-one. SES's account-level suppression list will catch repeat hard
  bounces automatically, but nothing today surfaces a complaint on a digest
  send as a "stop mailing this person" signal the way `kindle_bounce`
  notifications do for Kindle — that plumbing doesn't exist yet and would
  need to.
- Sending only capped-at-20 book ids means a big batch add (unlikely at this
  scale, but possible after a bulk pull like the Poe one) truncates silently
  in the email too, same as it does today for in-app notifications.

**Depends on:** email preferences existing first (or at minimum a hardcoded
opt-in check), and the SES sending quota/reputation being fine for low-volume
broadcast (untested — the domain has only ever sent Kindle personal-document
mail, which behaves differently in reputation terms than bulk-ish mail. Ten
recipients would obviously never be a volume problem.)

### Non-search entry point (shelves / picks per category)

**What it does:** gives the library a landing view that isn't an empty search
box — e.g. a "shelves" view keyed on the existing `category` facet, or a
handful of picks per category surfaced on load.

**Reuses:** everything needed already exists client-side. `facetCounts` and
`applyFilters` in `web/src/catalog/search.ts` already compute per-category
book lists from the same `Book[]` the grid renders; `category` is already a
facet key with real values today (`FACET_KEYS`, `facetValues`). A "browse by
category" view is largely a different arrangement of data `Library.tsx`
already has in memory (`merged`, `facets.category`), not new data fetching.

**Roughly what it takes:** a new landing state (before any query/filter is
set) that renders category tiles or a "few picks per category" grid instead
of (or above) the full list — no backend changes, no new lambda, no new
DynamoDB access pattern. This is the cheapest of the three by a wide margin.

**What could go wrong:** "a few picks per category" implies some selection
logic (recently added? random? curated?) that doesn't exist yet — random or
recency-based is cheap and honest; anything claiming to be "recommended"
would be inventing signal we don't have (see section 1 — no view/read data
exists to base recommendations on).

**Depends on:** nothing outside the web app. No infra, no new tables.

### Email preferences and unsubscribe in Settings

**What it does:** lets a reader control whether they get the digest at all,
and stop it without asking someone to change a Lambda env var.

**Reuses:** the per-reader row pattern already used for Kindle devices and
OPDS tokens (`DynamoStore`, keyed `pk = USER#<email>`, e.g.
`setOpdsTokenHash`/`clearOpdsToken`) is the direct template — a preferences
row is the same shape (`pk`, a dedicated `sk`, a couple of fields). The
Settings page (`web/src/components/SettingsPage.tsx`) already composes
independent per-reader sections (`DeviceList`, `OpdsSection`) the same way a
new `EmailPreferencesSection` would slot in.

**Roughly what it takes:** one new row type + a small API surface
(get/set on the library or notifications Lambda), one Settings section,
and a check in the digest-send path that reads it. A one-click unsubscribe
link in the email itself (no login required) is the standard practice for
mailed unsubscribe and needs its own signed/tokenized link, similar in shape
to the OPDS token mechanism already in the codebase — worth reusing that
pattern rather than inventing a new one.

**What could go wrong:** the least risky of the three technically — the main
failure mode is getting the *default* wrong (opt-in vs. opt-out). Given the
epic's own framing (people who didn't ask for it), default should be opt-out
of a broadcast until a reader has said yes, which argues for shipping this
gated behind an explicit opt-in rather than "on unless you turn it off."

**Depends on:** nothing else technically, but it's pointless to ship alone —
it only matters once there's a digest to control.

### Recommended order

1. **Non-search entry point** — cheapest, no backend risk, no risk of
   annoying anyone, and directly answers "what made you leave" (question 3)
   regardless of what the readers say. Safe to build speculatively.
2. **Email preferences (opt-in, default off)** — build this *before or with*
   the digest, not after, given the "unwanted email" risk named in the epic.
3. **Email digest** — build last of the three, and only once preferences
   exist to gate it, ideally after hearing back on question 2 (whether email
   is even wanted, and at what frequency).

### What's worth building before the readers answer

The non-search entry point (item 2 in the epic's list) is worth building
regardless of the answers — it's low-cost, reversible, has no downside for
someone who ignores it, and doesn't depend on anything the readers say.

The digest and preferences are not worth building before hearing back: the
whole point of asking first is that "email digest" might not be what either
reader wants (question 2 asks this directly), and preferences-without-a-digest
has no purpose on its own. The honest answer for those two is **wait**.
