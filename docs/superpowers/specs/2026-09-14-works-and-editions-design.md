# Works and Editions — Design Spec

**Date:** 2026-09-14
**Status:** Approved design, pending implementation plan
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
longer exist are dropped when the cache is written. The first run hashes the whole library once
(about 95 GB); later runs hash only new or changed files.

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
  warning, leaving the edition as its own work.

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

1. **Reassigns work ids from admin corrections** (see Admin corrections) and resolves chains.
2. **Groups entries into works** by `workId`, and editions within each work by `editionId`.
3. **Presents each work as a book-shaped object** so the card, search, facets, sort and windowed
   grid keep working, with an added `editions` list.

A catalog without `editionId`/`workId` (an old catalog with a new site) is treated as every entry
being its own edition and work, which is today's behaviour.

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

The **automatic work** of an edition is its catalog `workId`, before any correction.

### Storage

One row per corrected edition in the library table: `pk = WORKEDIT`, `sk = <editionId>`, attributes
`workId`, `by` (admin email) and `at` (ISO timestamp).

### Applying corrections on the site

For each catalog entry, the effective work id is computed by starting from `workEdits[editionId]` if
present, otherwise the catalog `workId`, then repeatedly moving from the current id `w` to
`workEdits[w]` if `w` has a row, otherwise to the catalog `workId` of `w`, until the id stops
changing. If a cycle is detected, the entry uses its catalog `workId`, with a console warning.

### Operations

A card's editions are those whose effective work id is the card's id. Every edition an operation
writes a row for becomes managed.

- **Merge card X into card W** — write `e → W` for every edition `e` of X.
- **Split edition S out of card C** — let the remainder be C's other editions. If the remainder is
  empty, do nothing. Let R be C if S is not C, otherwise the earliest-added edition of the
  remainder. Write `S → S`; if S is C, also write `R → R`; and write `e → R` for every other edition
  `e` of the remainder.
- **Reset card C to automatic grouping** — delete the rows of C's editions and of every edition whose
  automatic work (catalog `workId`) is the automatic work of any edition of C.

Writing explicit rows for the whole remainder, not only for S, is what keeps a split correct when S
was the only automatic link joining two other editions (A matches S and S matches B, but A does not
match B). Making every touched edition managed is what keeps a later merge from reviving automatic
links that an earlier split removed. Both cases were found by testing the rules, as recorded below.

**A managed edition is frozen.** A new copy arriving later will not join it through the
title-and-author rule, though it still joins through identical files or ISBN, and still joins any
unmanaged edition it matches. Resetting the card makes its editions automatic again.

### Why this model

The site applies corrections by following ids; a publish applies the folded `work` keys through the
indexer's union-find. The two must always produce the same cards. During design, a simulation of both
over 20,000 randomly generated libraries and 109,872 random merge, split and reset operations found
two defects in earlier versions of these rules (the bridge case and the split-then-merge case above),
and none in this version, where the site and a publish agreed after every operation. Resetting every
corrected card restored automatic grouping in all 5,000 of the histories tested for it. The testing
section requires the same property as a permanent test.

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
- **Reset to automatic grouping** in the dialog, when any edition of the card has a correction row.

Each operation reloads the overlay, so the grid regroups immediately.

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
| Admin correction names an unknown id | No effect on the site |
| Cycle in `workEdits` | Edits on the cycle ignored; catalog `workId` used; console warning |
| Invalid correction or reset request | 400 with a message |
| Non-admin correction or reset | 403 |
| DynamoDB failure on a correction | 502, as for other library routes |
| Catalog without the new fields | Each entry treated as its own edition and work |

## Testing

| Area | Tests |
|---|---|
| Indexer grouping | Identical bytes; shared ISBN including ISBN-10 vs ISBN-13; one bundle's EPUB and PDF pairing; edition-marker removal; name splitting and "Last, First" inversion; chained links. Must stay apart: the six Dune titles, the two *Happiness* books, same-title copies with no authors and different files. |
| Indexer ids | `editionId`/`workId` choose the earliest-added copy; a later copy joining leaves both unchanged; ties break on smallest id. |
| Indexer overrides | `work` to another id joins that work; `work` to itself isolates; a managed edition takes no automatic links in either direction but keeps edition links; unknown target ignored. |
| Indexer category | Override on any copy wins with the stated preference; otherwise the display edition's category. |
| Hash cache | Reuses unchanged entries; re-hashes on size or mtime change; rebuilds when corrupt; drops vanished files. |
| Grouping report | Writes the report; writes no catalog, covers, `added.json` or enrichment cache entries; never touches the network. |
| Site grouping | Groups by work; display edition choice; format union; bundle facet lists a work under each bundle; counts count works; search across copies; "recently added" by edition date; old catalog without fields behaves as today. |
| Site corrections | `workEdits` resolution including chains through untouched ids and the cycle guard. Merge, split of a later edition, split of the earliest edition and the bridge case each write the stated rows and give the expected cards; reset restores automatic grouping. Admin controls hidden for non-admins. |
| Site state | Reading status and category read order; writes target `workId`; downloaded across copies. |
| Correction consistency | A shared, generated fixture of randomised libraries and operation sequences, each step recording the rows and the resulting cards. The indexer's tests assert that grouping with the folded `work` keys gives those cards; the site's tests assert that resolving `workEdits` gives the same cards. The generator also asserts that resetting every corrected card restores automatic grouping. This pins the property the design was verified against, across both languages. |
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
