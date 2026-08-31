# Ebook Share — Design Spec

**Date:** 2026-08-31
**Status:** Approved design, pending implementation plan

## Purpose

A low-cost private website where an allowlisted set of friends can log in,
browse/search/filter Jay's ebook library, and download books directly. The
library (~1,659 files, ~73 GB, 49 Humble Bundle folders under
`/home/user/projects/ebooks`) is stored entirely in S3; nothing on the local
machine needs to run for the site to work.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Storage model | Entire library in S3 with **Intelligent-Tiering** (~$0.30–0.50/mo at steady state; no retrieval fees; instant downloads). The original local-storage/upload-on-request design was dropped — it saved under $1.50/mo and cost a daemon, request queue, and notification flow. |
| Auth | Cognito user pool with **Google sign-in only** (federated IdP). Facebook deferred; Apple rejected ($99/yr Apple Developer Program + Hide-My-Email complicates allowlisting). |
| Access control | Pre-signup Lambda trigger rejects Google emails not on a friend allowlist. |
| Search/browse | **Client-side** over a static `catalog.json` (~1–2 MB for ~1,000 titles). No search API. |
| Downloads | Single Lambda mints 15-minute presigned S3 GET URLs; API Gateway JWT authorizer validates tokens. |
| Tracking | Each download logged (user, book, format, timestamp) to DynamoDB (on-demand billing). |
| Metadata | Embedded EPUB/PDF metadata + **Open Library / Google Books enrichment**. Independent of the Notion tracker in `~/projects/ebook-library` (deliberate — no dependency on that project). |
| Domain | Custom domain Jay already owns, pointed at CloudFront with a free ACM certificate. |
| Frontend | React + Vite SPA, static build hosted on S3 behind CloudFront. |
| IaC | AWS CDK (TypeScript); one-command deploy. |
| Repo | This repo, `~/projects/ebook-share` — separate from the ebooks data folder and from the Notion tracker. |

## Architecture

```
Local machine (occasional):
  indexer: scan /home/user/projects/ebooks → extract metadata → enrich
           → sync books to S3 → generate covers → publish catalog.json

AWS (steady state):
  CloudFront (custom domain, ACM cert)
    ├── S3 site bucket: SPA build, catalog.json, cover thumbnails
    └── (books served via presigned URLs, not through CloudFront)
  S3 books bucket: private, Intelligent-Tiering
  Cognito user pool ── Google IdP ── pre-signup allowlist Lambda
  API Gateway (HTTP API, JWT authorizer)
    └── POST /download → Lambda → log to DynamoDB → presigned URL (15 min)
  DynamoDB `downloads` table (on-demand)
```

**User flow:** visit domain → sign in with Google (Cognito managed login;
non-allowlisted emails rejected at pre-signup with a friendly message) → SPA
loads `catalog.json` → all search/filter/sort client-side → Download button
calls `POST /download {bookId, format}` with JWT → Lambda logs and returns
presigned URL → browser downloads directly from S3.

**Publish flow (Jay only):** add new bundle folders locally → run indexer →
it diffs against the current catalog, uploads only new/changed files,
enriches new titles (cache prevents re-querying), regenerates
`catalog.json`, and invalidates CloudFront for the catalog path.

## Components

### 1. Indexer (Python CLI, runs locally)

Pipeline stages:

1. **Scan** — walk bundle folders; ignore `*.Zone.Identifier` files. Stable
   book/file IDs derived from a hash of the relative path.
2. **Extract** — EPUB: title, authors, description, subjects, ISBN, embedded
   cover from OPF. PDF: document-info title/author where present; first page
   rendered as cover fallback. CBZ: comic archive, filename-derived title.
   ZIP: inspect contents to label as "comic archive", "code samples", or
   "multi-book archive"; filename-derived title.
3. **Group** — the same title present in both `EPUB/` and `PDF/` within a
   bundle becomes one catalog entry with multiple formats, matched by
   normalized filename. Unmatched files remain standalone entries.
   Expected: ~1,659 files → roughly 900–1,100 entries.
4. **Enrich** — look up ISBN (preferred) or normalized title+author against
   Open Library, then Google Books as fallback: canonical title/authors,
   description, subjects, publication year, cover if none embedded. All
   responses cached on disk under `metadata/`; enrichment is best-effort and
   never blocks — failures fall back to extracted data.
5. **Categorize** — derive one top-level category per book from bundle name
   + subjects: `Tech & Programming`, `Security & Hacking`, `Fiction`,
   `Comics`, `TTRPG`, `Certification`, `Other/Lifestyle`. The indexer writes
   an `overrides.yaml`; manual edits there win on every re-run (applies to
   category and any other field).
6. **Publish** — sync book files to the books bucket (upload new/changed
   only), write ~400px WebP cover thumbnails and `catalog.json` to the site
   bucket, invalidate CloudFront cache for `catalog.json`.

### 2. Catalog schema (`catalog.json`)

```json
{
  "generatedAt": "ISO-8601",
  "books": [{
    "id": "hash",
    "title": "…",
    "authors": ["…"],
    "description": "…",
    "category": "Tech & Programming",
    "subjects": ["…"],
    "publisher": "…",
    "bundle": "Hacking by No Starch Press",
    "year": 2023,
    "formats": [{"type": "epub", "size": 1234567, "s3Key": "…"}],
    "coverUrl": "/covers/<id>.webp",
    "addedAt": "ISO-8601"
  }]
}
```

### 3. Frontend (React + Vite SPA)

- Card grid with covers; sidebar filters: category, format, publisher,
  bundle, author, year. Search box with fuzzy match over title, authors,
  description. Sort: title, author, year, recently added.
- Book detail view: description, metadata, one download button per format.
- Auth via Cognito managed login (OAuth code flow); tokens held in memory /
  refreshed via the standard Cognito flow.
- No SSR, no server rendering of any kind.

### 4. Backend

- **`POST /download`** — API Gateway HTTP API with built-in JWT authorizer
  (Cognito issuer). Lambda: validate `{bookId, format}` against a bundled
  copy of the catalog → write `{email, bookId, format, timestamp}` to
  DynamoDB → return presigned GET URL (15-minute expiry) with a
  `Content-Disposition` filename.
- **Pre-signup Lambda** — Cognito trigger; allowlist of friend emails read
  from an SSM parameter (editable without redeploy). Not listed → reject.
- **DynamoDB `downloads`** — PK `email`, SK `timestamp#bookId`; on-demand
  capacity.

### 5. Infrastructure

All resources (buckets, CloudFront distribution, ACM cert, Cognito pool +
Google IdP + trigger, HTTP API, Lambdas, DynamoDB table, DNS records if
using Route 53) defined in AWS CDK (TypeScript) in `infra/`. Single
deploy command.
Google OAuth client is created manually in Google Cloud Console (one-time);
its client ID/secret supplied as deployment parameters.

## Repo layout

```
ebook-share/
├── indexer/     # Python CLI + tests
├── web/         # React + Vite SPA
├── infra/       # SAM/CDK
└── docs/superpowers/specs/   # this spec + future design docs
```

Configuration (ebooks path, bucket names, domain) lives in a checked-in
config file with secrets/parameters kept out of git.

## Error handling

- Enrichment API failures → keep extracted metadata; log for later re-run.
- File missing in S3 at download time → 404 with clear message; logged as
  indexer drift.
- Expired presigned URL → user clicks Download again (new URL minted).
- Auth failures → handled by Cognito managed login; non-allowlisted signup
  shows a friendly rejection message.
- Indexer is idempotent and resumable: re-running never duplicates uploads
  or re-queries cached enrichment.

## Security

- Books bucket fully private; access only via short-lived presigned URLs.
- API callable only with a valid Cognito JWT (enforced at the gateway).
- Site bucket not public: CloudFront Origin Access Control only.
- Allowlist in SSM; secrets (Google OAuth) never in git.

## Costs (expected)

- S3 Intelligent-Tiering, 73 GB at steady state: ~$0.30–0.50/mo
  (+ ~$0.004/mo monitoring). First 30–90 days closer to ~$1.70/mo.
- Transfer out: free under 100 GB/mo aggregate.
- Cognito (Lite), Lambda, API Gateway, DynamoDB, CloudFront: free tier /
  pennies at friend scale.
- **Total: well under $1/month at steady state.** One-time upload of 73 GB:
  free (ingress), PUT requests ~$0.01.

## Testing

- Indexer unit tests: extraction, EPUB/PDF grouping, category derivation,
  overrides precedence (the logic-heavy core).
- Download Lambda: unit test for validation/logging/URL shape.
- Manual end-to-end after first deploy: sign in as an allowlisted account,
  browse, filter, download; verify a non-allowlisted account is rejected.

## Out of scope (deliberate)

- No Notion integration (the `~/projects/ebook-library` tracker stays
  independent).
- No request queue, notifications, or local daemon.
- No Facebook/Apple sign-in (can be added later; Cognito supports both).
- No per-user permissions beyond the allowlist; every friend sees the
  whole library.
- No in-browser reading; download only.
