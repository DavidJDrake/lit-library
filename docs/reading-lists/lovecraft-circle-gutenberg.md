# Lovecraft and his circle on Project Gutenberg

Survey of what Project Gutenberg holds (EPUB, US public domain) around H. P. Lovecraft,
taken 2026-09-04 via the Gutendex catalog API. Counts are EPUB editions where the
person is a credited author; "+" means more pages existed than the survey read.

## Status

- **Done:** the 24 Lovecraft titles (including collaborations with Zealia Bishop, Hazel
  Heald, Henry S. Whitehead, and E. Hoffmann Price) are in the library under the bundle
  `H. P. Lovecraft by Project Gutenberg`, with first-publication years and title casing
  set in `metadata/overrides.yaml`.
- **Done 2026-09-04:** the curated bundle below is in the library as
  `Weird Fiction the Lovecraft Circle by Project Gutenberg` — 109 EPUBs, with
  first-publication years, cleaned-up titles, and Gutenberg's summaries as descriptions
  in `metadata/overrides.yaml`. Bierce's *In the Midst of Life* is Gutenberg #13334
  (*Collected Works, Volume 2*); Poe's separate index volume was skipped.

## Related authors

| Author | Relationship to Lovecraft | EPUBs | Highlights on Gutenberg |
|---|---|---|---|
| Robert E. Howard | Closest correspondent; creator of Conan | 34 | Red Nails; The Hour of the Dragon; Shadows in Zamboula; Solomon Kane stories; Skull-Face |
| Lord Dunsany | The influence behind the "Dream Cycle" | 18 | The Gods of Pegāna; The Book of Wonder; The King of Elfland's Daughter; A Dreamer's Tales |
| Arthur Machen | *The Great God Pan* is the template for cosmic horror | 11 | The Great God Pan; The House of Souls; The Three Impostors; The Hill of Dreams |
| Algernon Blackwood | Lovecraft called *The Willows* the finest weird tale ever written | 27 | The Willows; The Wendigo; The Empty House; John Silence |
| Robert W. Chambers | *The King in Yellow* — Hastur/Carcosa, borrowed into the Mythos | 47 (≈1 relevant) | The King in Yellow (the rest are romance novels) |
| William Hope Hodgson | Cosmic horror before Lovecraft | 5 | The House on the Borderland; The Night Land; Carnacki, the Ghost-Finder; The Boats of the Glen Carrig |
| M. R. James | The antiquarian ghost story Lovecraft admired | 7 | Ghost Stories of an Antiquary (2 vols); A Warning to the Curious |
| Ambrose Bierce | Coined "Carcosa" and "Hastur"; American weird pioneer | 26 | Can Such Things Be?; In the Midst of Life; The Damned Thing; The Devil's Dictionary |
| Edgar Allan Poe | The root of it all | 41 | The Works of Edgar Allan Poe (5 vols); many single tales |
| Frank Belknap Long | Lovecraft's protégé ("The Hounds of Tindalos") | 26 | Mostly 1950s science fiction that lapsed into the public domain; a few weird tales |
| August Derleth | Founded Arkham House to keep Lovecraft in print | 4 | Nothing central; *Arkham House: The First 20 Years* is a bibliography |
| Clark Ashton Smith | Third of the "big three" Weird Tales writers | 2 | Poetry only (Ebony and Crystal; The Star-Treader) — his prose is not on Gutenberg |
| Bishop / Heald / Whitehead / Price | Revision clients and collaborators | — | Already in the library via the Lovecraft bundle |

Not on Gutenberg: Lovecraft's essay *Supernatural Horror in Literature*, Clark Ashton
Smith's stories, Derleth's Mythos work, most *Weird Tales* magazine issues.

## Curated bundle (109 titles)

Bundle name: `Weird Fiction the Lovecraft Circle by Project Gutenberg` (category rule
already maps `gutenberg` → Fiction; publisher derives as "Project Gutenberg").

- Robert E. Howard — all 34
- Lord Dunsany — all 18
- Arthur Machen — all 11
- Algernon Blackwood — all 27
- William Hope Hodgson — all 5
- M. R. James — all 7
- Robert W. Chambers — *The King in Yellow* only
- Ambrose Bierce — *Can Such Things Be?* and *In the Midst of Life* only
- Edgar Allan Poe — *The Works of Edgar Allan Poe*, volumes 1–5 only

Skipped on purpose: Chambers' romances, Long's rocket-ship paperbacks, Poe's scattered
single-story duplicates, Derleth's non-fiction.

## How to pull it

Same recipe as the Lovecraft bundle: query Gutendex per author, filter to EPUBs credited
to the author, download `formats["application/epub+zip"]` one per second with a
descriptive User-Agent into `~/projects/ebooks/<bundle>/EPUB/<slug>.epub`, then
`scripts/publish-new.sh`. Expect Gutenberg's `dc:date` to be the release year, not the
original publication year — fix via `metadata/overrides.yaml` before publishing.
