# Works and Editions — Design Spec

**Date:** 2026-09-14
**Status:** Implemented; amended 2026-09-15 after the final review (see Amendment)
**Backlog:** epic #30 (group duplicate editions), extended with admin corrections
**Builds on:** `2026-09-04-user-categories-design.md` (overlay pattern, `admins` group,
`pull-edits.py`), `2026-09-05-notifications-design.md` (`books_added`), the OPDS feed
(PR #47), and the reading-status and download-log work (PR #45).

## Purpose

The library shows one card per file it was given. Bundle sellers repackage the same titles,
so the catalog repeats itself: the same book bought in three bundles is three cards, a book's
EPUB and PDF sometimes land on separate cards, and a new edition of a book sits unconnected to
the old one. Publishing the Edgar Allan Poe bundle would add five more repeats, because
*The Works of Edgar Allan Poe* volumes 1-5 already arrived with the Lovecraft-circle bundle.

## Amendment (2026-09-15, from the final review)

The final branch review found that the site's original way of applying corrections (following
correction rows over the catalog `workId`) disagreed with the next publish once a publish had
carried corrections, because the published `workId` already includes them. The review recommended,
and this amendment adopts, **one grouping model run by both sides**: the catalog carries each
edition's automatic work links (`workLinks`), and the site runs the indexer's union-find over them
and the correction rows. The sections changed are "Ids and catalog shape", "Hash cache", "Override
key", "Cards", "Per-card state" (clearing a status), "Applying corrections on the site",
"Operations", "Why this model", "Error handling" and "Testing".

This spec makes a card represent a **work**: every edition of a title by the same author,
however many bundles its files arrived in. Grouping is automatic and conservative, and admins
can correct it in the app.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| What a card is | **One card per work; editions inside.** Different editions of a title share a card with an edition picker, rather than one card per edition. |
| How corrections happen | **Merge and split buttons in the app**, not only override entries. |
| Who can correct | **Admins only** (Cognito `admins` group). A wrong merge hides a book inside another card. |
| Scope | **One spec for both** automatic grouping and in-app corrections. |
| Architecture | **Flat catalog plus computed grouping keys** (Approach A). Every copy keeps its id; `catalog.json` gains `editionId` and `workId`; the site groups; corrections are an overlay. |
| Rejected: nested catalog with new work ids | Every id consumer changes at once and reader state needs migrating. |
| Rejected: grouping served from DynamoDB | Abandons the static signed-cookie catalog; the category design already rejected it. |
| Unmatched books | **Stay separate.** An undecidable case never merges automatically. |

## Terms

- **Copy** — one entry in `catalog.json` today: one bundle's file(s) for a title, with an id
  derived from bundle and filename. Unchanged by this spec.
- **Edition** — copies that are the same book: identical bytes, the same ISBN, or one
  bundle's formats of the same title.
- **Work** — editions that are the same title by the same author. One card.

## Grouping rules

Grouping runs in the indexer over all copies, as a union-find: every rule that links two copies
joins their groups, so links chain (A matches B by file, B matches C by ISBN: one edition).

### Editions

Two copies are the same edition when any of these holds:

1. **A file is byte-identical** — the SHA-256 of any file of one equals that of a file of the
   other.
2. **They share an ISBN.** ISBNs are normalised to 13 digits, so an ISBN-10 and its ISBN-13
   match. Only ISBNs the extractors already find are used.
3. **Same bundle, same edition-insensitive title, no format in common.** This is how one
   bundle's EPUB and PDF of a book become one edition when their filenames failed to pair.

### Works

Two editions are the same work when **both** hold:

- **Same edition-insensitive title.** Lowercased; explicit edition markers removed
  ("Second Edition", "2nd Edition", "(3rd edition)", "Revised Edition", "Edition 2",
  "2nd ed."); then everything but letters and digits removed. **Subtitles are never removed.**
- **At least one author in common**, after normalisation: each author string is split on
  "and", "&", ";", "|" and line breaks; a part of the form "Last, First" (exactly one comma)
  becomes "First Last"; then everything but letters is removed, lowercased.

A copy with no authors joins a work only through edition rules 1 and 2.

### Why these rules and not looser ones

Measured on the live catalog (1,495 copies) during brainstorming:

- Removing text after a colon merged six different novels (*Dune: The Butlerian Jihad* through
  *Dune: The Lady of Caladan*) into one work. Subtitles are therefore kept.
- Title-only matching merges different books: two unrelated *Happiness* books (Tim Lomas;
  Thich Nhat Hanh) and two unrelated *Ghidra* books. The shared-author rule keeps them apart.
- Naive author comparison failed on the same book written "MARCUS J. CAREY and JENNIFER JIN",
  "Michelle Chismon; Kate Gawron" and "Anderson, Kevin J."; the normalisation above merges them.
- Of 95 same-title groups under these rules: 85 merge, 2 correctly stay apart (the two above),
  and 8 have no authors (Cyberpunk supplements), which merge through identical files.
- Of 90 cross-bundle same-title groups, 79 were byte-identical copies.
- The Poe *Works* volumes in both bundles are byte-identical, with the same Gutenberg identifier.
- Estimated result: about 1,380 editions and about 1,373 cards, roughly 122 fewer cards. (File
  size stood in for the hash in this estimate; the grouping report below gives exact figures.)

## Ids and catalog shape

Every catalog entry keeps its current `id`. Two fields are added:

- **`editionId`** — the `id` of the edition's earliest-added copy (by `addedAt`, then smallest
  `id`).
- **`workId`** — the `editionId` of the work's earliest-added edition, where an edition's added
  date is that of its earliest copy (ties: smallest `editionId`).

- **`workLinks`** — only on an edition's canonical entry (the entry whose `id` is its
  `editionId`), and only when non-empty: the sorted edition ids of every other edition linked to
  this one by the title-and-author rule. The links are computed **ignoring overrides**, so a
  managed edition still lists its automatic links; the field is symmetric (if `b` lists `a`, `a`
  lists `b`). Every linked pair is listed, not just enough links to connect each work, because
  removing a managed edition's links must leave the rest connected exactly as the indexer's
  union-find does. Non-canonical copies and editions with no links omit the field.

An ungrouped copy has `editionId == workId == id`.

**Stability.** Because the canonical copy is the earliest-added, a copy that arrives later joins
an existing edition and work without changing either id. The one case that moves an id: deleting
a work's earliest copy (for example with `prune --delete`) passes `workId` to the next-earliest
copy, and anything stored against the old id stops attaching. This is documented, not engineered
around; deleting books is rare.

Because entries keep their ids and `catalog.json` stays a flat list of copies, every existing id
consumer — download, Kindle, OPDS acquisition, reading statuses, the download log, category
edits, notifications — continues to accept the ids it has today.

### Display edition

A work's **display edition** is its newest edition: highest `year` (a missing year sorts lowest),
then latest edition added date, then smallest `editionId`. The indexer uses it to settle
categories and the site uses it to present the card, so both apply this one definition.

## Indexer

### Hash cache

`metadata/hashes.json`, gitignored like `publish-state.json`, maps a copy's relative file path to
`{size, mtime, sha256}`. A file is re-hashed only when its size or modification time changed or it
has no entry. A missing or unreadable cache is rebuilt with a warning. Entries for files that no
longer exist are dropped when the cache is written after a complete scan; a run limited with
`--limit`, or one that stops early, drops nothing. The cache is written even when a run fails or is
interrupted, and is checkpointed every 200 newly hashed files, so an interrupted first run keeps its
progress. The first run hashes the whole library once (about 95 GB); later runs hash only new or
changed files.

### Grouping step

Runs inside `build_books` after extraction and overrides, before `write_outputs`. It is a pure
function from the list of books (with their file hashes, ISBNs, titles, authors, bundles, formats
and added dates) to `editionId` and `workId` per book, so it is unit-testable without files.

### Override key

One new key in `overrides.yaml`, keyed by an **edition id**:

- **`work: <id>`** — makes the edition **managed**. A managed edition takes part in no automatic work
  links: the title-and-author rule ignores it in both directions. If `<id>` is the edition's own id,
  the edition is its own work; otherwise it joins the work containing `<id>`. Edition-level links
  (identical files, ISBN) are unaffected. A target id not present in the library is ignored with a
  warning, leaving the edition managed and joined to nothing. An override (or correction row) keyed
  by, or naming, a non-canonical copy id applies to that copy's edition. When several `work` keys
  apply to one edition, the key that is the edition id wins, otherwise the smallest key. A key
  naming no copy at all is ignored with a warning.

`work` keys are owned by the app's admin corrections: `pull-edits.py` writes them from correction
rows and removes any `work` key that has no row (see Folding corrections back). Corrections are
therefore made in the app, not by editing the file; a hand-written `work` key would be removed by the
next fold.

### Category settling

Category is a shelf, which belongs to the work. After grouping, every copy of a work is given the
same category:

1. a `category` override on any copy of the work — preferring the copy whose `id` is the `workId`,
   then the earliest-added copy; otherwise
2. the category of the work's display edition (see Display edition).

Titles, years, descriptions and other fields stay per copy, since editions genuinely differ.
Estimated from the live catalog, 8 works currently have copies in different categories, mostly
certification guides filed as Certification by one bundle's rules and as Security or Tech by
another's. The grouping report lists them.

### Grouping report

A read-only subcommand: `ebook_indexer grouping-report --config ../config.yaml`. It runs the same
scan, extraction and grouping as `index`, with enrichment in **cache-only mode** (a cache miss is
treated as not found, never fetched and never written), and writes `out/grouping-report.md`. It
must not write `catalog.json`, covers, `added.json` or any enrichment cache entry; it may update
`metadata/hashes.json`.

The report lists: total copies, editions and works; every work containing more than one copy, with
each copy's title, bundle, authors, year and the rule that linked it; every work whose category
settles to a value some copy did not have; and every same-title pair kept apart, with the reason.

## Site

### Cards

The site loads `catalog.json` and the overlay as today, then:

1. **Works out each entry's work** from the catalog's `workLinks` and the admin corrections (see
   Applying corrections on the site). Until the overlay has loaded, it uses the catalog `workId`.
2. **Groups entries into works** by that work id, and editions within each work by `editionId`.
3. **Presents each work as a book-shaped object** so the card, search, facets, sort and windowed
   grid keep working, with an added `editions` list.

A catalog without `editionId`/`workId`/`workLinks` (an old catalog with a new site) is treated as
every entry being its own edition and work with no automatic links, which is today's behaviour.

A card shows its **display edition** (defined above).

- Title, authors, cover, year, description and publisher come from the display edition's
  canonical copy.
- Format badges are the union of every edition's formats.
- When a work has more than one edition, an **"N editions" chip** overlays the cover, positioned
  out of flow like the reading-status chip, so card height is unchanged. Multiple copies of one
  edition show no chip.

### Book dialog

- When a work has more than one edition, an **edition picker** lists them, newest first, each
  labelled with its year, any edition marker from its title, and its formats. It opens on the
  display edition. Selecting an edition switches the cover, details, description, download
  buttons and Kindle send to that edition.
- An **"In:"** line lists every bundle containing a copy of the work.
- **Serving a format:** within the selected edition, the copy used for a format is the most
  recently added copy that has that format (ties: smallest `id`). Download and Kindle requests
  send that copy's `id` and the format, exactly as today.

### Search, facets and sort

- **Search** matches the title and authors of any copy in the work.
- **Facet counts and the result total count works.** The bundle facet lists a work once under each
  bundle containing any of its copies; the format facet uses the union of formats.
- **Title, author and year sort** use the display edition.
- **"Recently added"** uses the work's latest edition added date. A new edition moves the card; a
  further copy of an existing edition does not.

### Notification titles

Notifications show a book's title by looking it up by copy id. That lookup keeps working unchanged,
because every copy keeps its id and its catalog entry.

## Per-card state

### Reading status (per reader)

- **Read:** the status stored against the `workId`; otherwise a status stored against any copy of
  the work, preferring copies of the display edition, then earliest-added.
- **Write:** stored against the `workId` through the existing endpoint. Rows stored against other
  copies are left in place; they never override a `workId` row. If an edition is split off, the
  part keeping the `workId` keeps the status, and the split-off card resolves from its own copies.
- **Clear:** choosing "No status" deletes the status of the `workId` and of every copy of the work
  that has one, so the card shows no status afterwards. Deleting only the `workId` row would let the
  read order find a status on another copy.

Existing statuses therefore appear on the right card with no migration.

### Downloaded (per reader)

A card is downloaded when any copy of the work is in the reader's download history. In the edition
picker, an edition is marked downloaded when any of its copies is. The download log is unchanged.

### Category (shared)

- **Read:** a category edit stored against the `workId`; otherwise an edit against any copy of the
  work (same preference order as reading status); otherwise the catalog category, which the indexer
  has already made consistent across the work.
- **Write:** stored against the `workId` through the existing endpoint. A suggestion whose attached
  book is any copy id resolves to that copy's work when accepted, through the same read order.

## Admin corrections

### Model

A correction is a row assigning an edition to a work: `editionId → workId`. Merge, split and reset
are operations in the site that compute a set of rows to write or delete; the server stores rows
and knows nothing of the operations. Corrections act on editions, never on individual copies.

The **automatic work** of an edition is its connected component over the automatic work links
(`workLinks`) alone, ignoring every correction row. It is not the catalog `workId`, which a publish
computes with the folded corrections.

### Storage

One row per corrected edition in the library table: `pk = WORKEDIT`, `sk = <editionId>`, attributes
`workId`, `by` (admin email) and `at` (ISO timestamp).

### Applying corrections on the site

The site groups with the indexer's own model, so a publish of the folded rows gives exactly the
cards the site shows, card ids included. Given the catalog's editions (an edition's added date is
that of its canonical copy), its `workLinks`, and the overlay's `workEdits`:

1. **Map rows to editions.** Each row's key and its target are mapped through copy id → edition
   id, so a row keyed by, or naming, a non-canonical copy applies to that copy's edition. A row
   whose key is no catalog entry is ignored, with a console warning. When several rows map to one
   edition, the row keyed by the edition id wins, otherwise the smallest key.
2. **Managed editions** are those that have a row after mapping.
3. **Union along every automatic work link whose two ends are both unmanaged.**
4. **Union each managed edition with its mapped target.** A target that is the edition itself joins
   nothing; a target that is no catalog entry joins nothing, with a console warning (the edition
   stays managed).
5. **A card's id** is the earliest-added edition of its component (ties: smallest edition id).

Before the overlay loads, the site groups by the catalog `workId`, which the last publish computed
with the same model and the rows folded at that time.

Union-find has no cycles to guard against: rows `a → b` and `b → a` simply put `a` and `b` on one card.

### Operations

A card's editions are those grouped onto it as above. Every edition an operation writes a row for
becomes managed.

- **Merge card X into card W** — write `e → W` for every edition `e` of X. W's editions keep their
  rows and links, and X's editions only join W, so the result is exactly X and W together. The
  merged card's id is its earliest edition, which may be one of X's.
- **Split edition S out of card C** — let the remainder be C's other editions. If the remainder is
  empty, do nothing. Let R be C if S is not C, otherwise the earliest-added edition of the
  remainder. Write `S → S`, and `e → R` for every edition `e` of the remainder other than R. Write
  `R → R` too, but only when some row already maps to R's edition (a row keyed by one of R's
  non-canonical copies included) — otherwise leave R with no row of its own.
- **Reset card C to automatic grouping** — the scope is every edition in the automatic work (links
  only, ignoring rows) of any edition of C. Delete every row whose mapped key lies in the scope.
  Afterwards every edition in the scope is unmanaged, so each of C's editions is at least on one card
  with its whole automatic work. The **Reset** button shows when any row's mapped key lies in the
  scope of the card's editions, so after a reset it reflects whether any such row remains (for
  example a row on an edition outside the scope that still points into it).

Writing explicit rows for the whole remainder, not only for S, is what keeps a split correct when S
was the only automatic link joining two other editions (A matches S and S matches B, but A does not
match B). Writing `R → R` unconditionally kept a split correct when R already had a row pointing at
S, but froze R out of automatically joining a newly published matching edition until Reset, even
when nothing had ever pointed at R. Writing it only when R already had a row — from R itself or one
of its copies — keeps the split correct in exactly the cases that need it (clearing the stale row)
without freezing a remainder that had never been touched. Making every touched edition managed is
what keeps a later merge from reviving automatic links that an earlier split removed.

**A managed edition is frozen.** A new copy arriving later will not join it through the
title-and-author rule, though it still joins through identical files or ISBN, and still joins any
unmanaged edition it matches. Resetting the card makes its editions automatic again.

### Why this model

The first version of this design had the site follow correction rows over the catalog `workId` and
relied on a publish reproducing the result. That held only while the catalog `workId` was the
automatic grouping. After `pull-edits.py` and a publish, the catalog `workId` already includes the
corrections while the rows stay in DynamoDB, and the indexer names a merged work after its earliest
edition rather than the merge target. The final review showed the site and the next publish then
disagreeing: a merge into a card whose id had moved formed a cycle and appeared to do nothing, and a
reset deleted rows while the card stayed merged until the next publish. Over 20,000 histories with
publishes interleaved it counted thousands of mismatched resets and hundreds of mismatched merges
and splits. Resolving over an automatic-only work id fixed a static library but still disagreed
whenever a newly published edition linked to a managed one.

Running the same union-find on both sides removes the disagreement by construction: the site and a
publish compute the same function of the same inputs (editions, automatic links, rows). What remains
to verify is that each operation's rows produce the card the admin asked for under that model. A
simulation of 20,000 random histories, interleaving publishes that add editions (including editions
linked to managed ones) with merge, split, reset and stale rows keyed by or naming copy ids or
unknown ids, found one defect in the split rule (the remainder's own row pointing at S, fixed by
writing `R → R`), and none after it: every operation did what was asked, the model's cards equalled
the real indexer's cards with the rows folded, ids included, after every step, and resetting every
corrected card restored automatic grouping. The testing section requires the same property as a
permanent test.

### API

Both routes are admin-only, added to `ADMIN_ROUTES` and authenticated by the existing JWT authorizer.

| Route | Body | Result |
|---|---|---|
| `PUT /api/works/edits` | `{"edits": {"<editionId>": "<workId>", ...}}` | 204; all rows written in one transaction |
| `POST /api/works/edits/reset` | `{"editionIds": ["<editionId>", ...]}` | 204; rows deleted, idempotent |

Validation (400): every id matches `^[0-9a-f]{16}$`; `edits` has 1 to 100 entries; `editionIds` has 1
to 100 entries with no duplicates. Non-admins receive 403 as for other admin routes. The library
Lambda does not read the catalog; an id that exists nowhere simply has no effect.

`GET /api/library` adds **`workEdits`**: an object mapping `editionId` to `workId` for every row.

### Admin UI

Shown only when the ID token's `cognito:groups` contains `admins`:

- **Merge into…** in the dialog header, opening a search over cards (excluding the current card) to
  choose the target.
- **Split into its own card** beside each edition in the picker, when the work has more than one
  edition.
- **Reset to automatic grouping** in the dialog, when any row lies in the card's reset scope (see
  Operations).

Each operation reloads the overlay, so the grid regroups immediately. While an operation runs the
dialog's controls are disabled. If it fails, an error toast shows and nothing else changes: the
dialog stays on its card and the merge picker stays open. After a successful merge the dialog shows
the card now holding the merge target; after a split or reset it shows the card now holding the
edition it was showing, so a card whose id changed does not close the dialog.

### Folding corrections back

`scripts/pull-edits.py` folds `WORKEDIT` rows into `overrides.yaml`: each row becomes `work: <workId>`
on its edition, and an edition with no row loses the key. With the override semantics above, the next
publish groups exactly as the site does.

**`pull-edits.py` must preserve comments.** Today it drops every comment in `overrides.yaml` except
the leading header when it writes, which would erase the section notes explaining the Witcher Comics
settings and the pinned Raspberry Pi magazine issues. It is changed to update entries without
discarding comments or reordering existing entries.

## Notifications

`scripts/notify-books-added.py` counts **new editions**, not new copies: a new catalog entry is
counted when its `editionId` equals its own `id`. A copy joining an existing edition has an older
`editionId` and is not counted. The payload's `bookIds` are the counted ids (at most 20, as today).
Publishing the Poe bundle would announce 17 new books, not 22.

## OPDS feed

The feed lists **one publication per edition**. The download Lambda groups catalog entries by
`editionId`; each publication takes its metadata from the edition's canonical copy, and each format's
acquisition link points at the most recently added copy with that format (ties: smallest `id`).
Admin corrections do not affect the feed, since they move editions between works and never change
an edition's contents. Acquisition URLs keep carrying an existing copy id.

## Error handling

| Situation | Behaviour |
|---|---|
| Hash cache missing or corrupt | Rebuilt, with a warning |
| A scanned file unreadable during hashing | That file contributes no hash; warning; the book is still indexed |
| `work` names an unknown id | The edition stays its own work, with a warning |
| Admin correction keyed by an unknown id | Row ignored, console warning; a publish ignores the folded key the same way |
| Admin correction naming an unknown target | The edition shows as a managed card of its own, as it would after a publish; console warning |
| Invalid correction or reset request | 400 with a message |
| Non-admin correction or reset | 403 |
| DynamoDB failure on a correction | 500, as for other library routes |
| Catalog without the new fields | Each entry treated as its own edition and work |

## Testing

| Area | Tests |
|---|---|
| Indexer grouping | Identical bytes; shared ISBN including ISBN-10 vs ISBN-13; one bundle's EPUB and PDF pairing; edition-marker removal; name splitting and "Last, First" inversion; chained links. Must stay apart: the six Dune titles, the two *Happiness* books, same-title copies with no authors and different files. |
| Indexer ids | `editionId`/`workId` choose the earliest-added copy; a later copy joining leaves both unchanged; ties break on smallest id. |
| Indexer overrides | `work` to another id joins that work; `work` to itself isolates; a managed edition takes no automatic links in either direction but keeps edition links; unknown target ignored; keys and targets naming a non-canonical copy apply to its edition; the edition-id key wins over a copy-id key. |
| Indexer catalog | `workLinks` on canonical entries only, symmetric, listing every automatic pair and ignoring overrides; omitted when empty. |
| Indexer category | Override on any copy wins with the stated preference; otherwise the display edition's category. |
| Hash cache | Reuses unchanged entries; re-hashes on size or mtime change; rebuilds when corrupt; drops vanished files after a complete scan only; saved when a run fails; checkpointed during a run. |
| Grouping report | Writes the report; writes no catalog, covers, `added.json` or enrichment cache entries; never touches the network. |
| Site grouping | Groups by work; display edition choice; format union; bundle facet lists a work under each bundle; counts count works; search across copies; "recently added" by edition date; old catalog without fields behaves as today. |
| Site corrections | Grouping over `workLinks` and `workEdits`: managed editions skip links, rows keyed by or naming copy ids, unknown keys and targets, catalog `workId` before the overlay loads. Merge, split of a later edition, split of the earliest edition and the bridge case each write the stated rows and give the expected cards; reset deletes the rows in scope. A failed operation leaves the dialog and merge picker as they were; operations disable the controls while running; after an operation the dialog shows the card now holding the edition it was showing. Admin controls hidden for non-admins. |
| Site state | Reading status and category read order; writes target `workId`; clearing a status removes it from every copy that has one; downloaded across copies. |
| Correction consistency | A shared, generated fixture (`scripts/gen-work-corrections-fixture.py`, the reference model) of randomised libraries with non-canonical copies, and step sequences that interleave publishes (some adding editions, including editions linked to managed ones) with merges, splits, resets and stale rows. Each step records the rows and the resulting cards with their ids; each publish records the catalog `workId` of every entry. The indexer's tests assert that grouping with the folded `work` keys gives those cards and ids. The site's tests rebuild the catalog the site would see (entries present at the last publish, `workLinks`, and that publish's `workId`), assert that grouping with the rows gives the same cards and ids, that grouping without an overlay gives the recorded catalog `workId`, and that the row builders reproduce the recorded rows. The generator refuses a fixture in which an operation does not do what was asked or resetting every corrected card fails to restore automatic grouping. |
| Card layout | The editions chip leaves card height unchanged. |
| Library Lambda | Write and reset: success, validation failures, 403 for non-admins, single transaction for writes; overlay includes `workEdits`. Routes asserted against the real JWT authorizer, as existing routes are. |
| Download Lambda | OPDS lists one publication per edition; acquisition uses the most recently added copy per format. |
| Scripts | `pull-edits.py` folds both correction kinds and preserves comments and entry order; `notify-books-added.py` counts editions. |

## Rollout

The site tolerates catalogs with and without the new fields, so steps can run in any order without a
broken page. Deploys and publishes are run by the user; the permission classifier blocks them for
agents.

1. Merge the implementation.
2. Run the grouping report against the real library (read-only) and review it, noting any grouping to
   correct.
3. Deploy infrastructure (library and download Lambdas).
4. Publish from the main checkout. The first publish hashes the whole library once.
5. Deploy the web app.
6. Verify live: the card count matches the report; existing reading statuses show on the right cards;
   merge, both kinds of split and reset work and survive a reload; a download from a merged card works;
   OPDS lists each edition once.
7. Make the corrections noted in step 2 in the app, run `pull-edits.py`, and publish, so
   `overrides.yaml` carries them.
8. Publish the Edgar Allan Poe bundle; its five *Works* volumes join the existing cards.

## Out of scope

- Splitting copies within an edition, or correcting edition grouping in the app.
- Choosing a specific copy to download.
- Grouping OPDS publications by work.
- Automatically merging same-title copies that have no authors and no file or ISBN link.
- Notifying readers about merges or splits.
- Recovering state stored against a deleted work's former id.
