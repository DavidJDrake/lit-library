# Backups That Survive Losing the Bucket — Design Spec

**Date:** 2026-09-12
**Status:** Approved design, pending implementation plan
**Backlog:** #28
**Builds on:** `scripts/backup.sh` (metadata sync, archive, table exports),
`infra/lib/storage.ts` (bucket definitions), `infra/lib/alerts.ts` (SNS topic and
the `watch(fn)` helper).

## Purpose

Everything that cannot be regenerated is currently backed up to a `_backup/`
prefix **inside the books bucket it is backing up**. That bucket has versioning
disabled, the backup only runs when someone remembers to run it (last run
2026-09-06), and `infra/README.md` states plainly that the DynamoDB export is
"a log of that run's table contents, not a restorable snapshot". So the one
dataset that exists nowhere else — reading statuses, category edits,
suggestions, Kindle devices, OPDS token hashes — has no restore path at all.

This spec gives that data continuous recovery, moves backups out of the blast
radius of the thing they protect, and proves the restore works by rehearsing it.

The threat model is our own mistakes: a bad sync, `prune --delete` pointed at a
misconfigured library root, or stack surgery. Not AWS losing data.

## Key decisions (agreed during brainstorming)

| Decision | Choice |
|---|---|
| Trigger model | **Three layers, each matched to how its data changes.** PITR for tables (continuous), `metadata/` on publish (the only event that changes it), a weekly export as belt-and-braces. |
| Backup location | **A separate bucket**, versioned, in the same account and region. |
| Books in the backup | **No.** The books exist locally (89 GB) and in S3; S3 is already the second copy. |
| Books bucket versioning | **On**, with noncurrent versions expiring after 30 days. |
| Export Lambda permissions | **Read tables, put objects. No delete.** A compromised function cannot erase the backups it writes. |
| Missed-schedule detection | **Out of scope.** The Errors alarm catches a crashing job, not a job that never fires. PITR is the continuous protection; a heartbeat metric is not worth the machinery here. |
| Cross-region / cross-account | **Out of scope.** Cheap but guards a remote failure; revisit separately. |

## What is and is not protected

| Data | Size | Regenerable? | Covered by |
|---|---|---|---|
| DynamoDB library table | 12,451 B / 106 rows | No | PITR + weekly export |
| DynamoDB downloads table | 1,487 B / 9 rows | No | PITR + weekly export |
| `metadata/` (cache, `added.json`, `overrides.yaml`, publish state) | 5.2 MiB / 1,210 files | Slowly and imperfectly | Backup on publish |
| `infra/outputs.json`, `infra/config.local.json`, `config.yaml` | ~2 KB | No | Backup on publish |
| Books | 88.2 GiB / 1,822 objects | Yes — local copy | Books bucket versioning |

## Layer 1 — Point-in-time recovery

Both tables gain:

```ts
pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
```

in `infra/lib/library.ts` (`Table`) and `infra/lib/api.ts` (`Downloads`). The
boolean `pointInTimeRecovery` prop is deprecated in the installed aws-cdk-lib
2.268 and must not be used. Enabling is an in-place update: no replacement, no
downtime, no data movement.

This gives continuous recovery to any second in the trailing 35 days, which is
the layer that closes the "no restore path" gap above.

**Cost:** $0.20/GB-month against 13.9 KB — about $0.000003/month.

## Layer 2 — `metadata/` is backed up when it changes

`scripts/publish-new.sh` calls `scripts/backup.sh` as its last step, after the
notification. Publishing is the only thing that changes `metadata/`, so a
nightly timer would copy identical bytes most days and still miss a mid-day
publish.

A backup failure must **not** fail the publish: the books are already live by
that point. The script prints a loud warning and exits zero, matching how it
already treats a failed notification.

## Layer 3 — Weekly export

New construct `infra/lib/backup.ts`:

- `NodejsFunction` at `infra/lambda/backup/index.ts` (Node 22, the pattern used
  by every other function here), environment `LIBRARY_TABLE`, `DOWNLOADS_TABLE`,
  `BACKUP_BUCKET`.
- `events.Rule` on `Schedule.rate(Duration.days(7))` targeting that function.
- IAM: `grantReadData` on both tables, `grantPut` on the backup bucket only.
  Deliberately no `s3:DeleteObject` and no write access to any other bucket.
- Constructed **after** `Alerts` in `ebook-share-stack.ts`, then registered with
  `alerts.watch(backup.fn)` so errors email through the existing SNS topic —
  the same sequencing `Kindle` already uses.

The handler scans each table with pagination (`ExclusiveStartKey` until
exhausted — the tables are small today but a scan that silently truncates is a
backup that silently lies) and writes:

```
dynamodb/library-<stamp>.json
dynamodb/downloads-<stamp>.json
```

where `<stamp>` matches the shell script's `%Y-%m-%dT%H%M%SZ`. The payload keeps
the `{"Items": [...], "Count": n}` shape that `aws dynamodb scan --output json`
produces, so one restore procedure covers files written by either producer. The
handler logs row counts through `shared/log` and throws on failure, so a broken
run reaches the Errors alarm.

## The backup bucket

`Storage` gains `backupBucket`:

- `blockPublicAccess: BLOCK_ALL`, `encryption: S3_MANAGED`, `enforceSSL: true`
- `removalPolicy: RETAIN` — a stack teardown must never take the backups
- `versioned: true`
- Lifecycle: noncurrent versions expire after 90 days; incomplete multipart
  uploads abort after 7 days
- **No** Intelligent-Tiering transition: these objects are mostly under 128 KB,
  the size floor for auto-tiering, so the rule would add cost reporting noise
  and no saving

Exposed as `CfnOutput` **`BackupBucketName`**. `scripts/backup.sh` reads it from
`infra/outputs.json` alongside the names it already reads, and **fails loudly if
the output is absent** rather than falling back to the books bucket — a silent
fallback would recreate exactly the fate-sharing this epic removes. The prefixes
inside the bucket stay as they are (`metadata/`, `metadata-archives/`,
`dynamodb/`, `infra/`, `config.yaml`), so the restore commands change only in
which bucket they name.

`scripts/apply-outputs.py` needs no change: it maps outputs into `config.yaml`
for the indexer, and the indexer has no interest in backups.

## Books bucket versioning

`versioned: true` on the books bucket, plus a lifecycle rule expiring noncurrent
versions after 30 days. Books are written once and rarely rewritten, so steady
state adds nothing; the rule caps the damage of a mass delete at roughly $2.18
for a single month.

**Irreversible:** S3 versioning can be suspended but never returned to
"never enabled". Worth stating in the README next to the setting.

## Migrating the existing `_backup/` prefix

One-off, during rollout: copy the 1,227 existing objects (~1.1 MB) into the new
bucket, verify the object count matches, then delete `_backup/` from the books
bucket so there is exactly one home for backups. This is a documented rollout
step, not code.

## Restore paths

**Reader data (the case that matters).** PITR:

```
aws dynamodb restore-table-to-point-in-time \
  --source-table-name <table> --target-table-name <table>-restore \
  --use-latest-restorable-time
```

A PITR restore always creates a **new table**. Recovery therefore has a second
step that is easy to forget under pressure: repoint the Lambdas' `LIBRARY_TABLE`
/ `DOWNLOADS_TABLE` environment variables at the restored table (or copy rows
back into the original). The README must say so.

**Reader data, secondary.** The weekly JSON export is a readable snapshot for
auditing and for item-by-item reinstatement. It is not the primary restore path
and the README should stop implying otherwise.

**`metadata/` and config.** `aws s3 sync` from the backup bucket, or a specific
`metadata-archives/metadata-<stamp>.tar.gz` for a point in time.

**Books.** Re-upload from the local library, or recover a deleted object from
its noncurrent version within 30 days.

## The rehearsal

Part of the implementation, not a follow-up: restore the library table to
`<table>-drill` via PITR, count its rows, compare against the live table, delete
the drill table, and record the commands and observed counts in
`infra/README.md`. A restore procedure nobody has run is a hypothesis.

## Testing

| Test | Asserts |
|---|---|
| `storage.test.ts` | Backup bucket: versioning enabled, public access blocked, RETAIN, noncurrent expiry. Books bucket: versioning enabled with its 30-day rule, existing Intelligent-Tiering rule intact. |
| `backup-construct.test.ts` (new, mirrors `notifications-construct.test.ts`) | Weekly schedule rule targets the function; environment names; IAM grants read on both tables and put on the backup bucket, with **no** delete action and no grant on the books bucket. |
| `backup-export.test.ts` (new) | Paginated scan spanning more than one page returns every row; object keys carry the stamp; a failing scan or put propagates rather than exiting zero. |
| `library.test.ts`, `api.test.ts` | PITR enabled on each table. |
| `stack.test.ts` | `BackupBucketName` output present; the backup function is registered with `alerts.watch`, so the alarm count rises from 7 to 8. |

## Cost

| Item | Monthly |
|---|---|
| PITR, both tables | ~$0.000003 |
| Backup bucket storage (5.2 MiB) | ~$0.0001 |
| Requests (first sync 1,210 PUTs, then deltas; weekly exports) | ~$0.01 |
| Books bucket versioning, steady state | ~$0 (worst case ~$2.18 for one month) |
| **Total** | **~$0.02** |

## Rollout

1. Deploy: creates the backup bucket, enables PITR in place, adds the schedule.
2. Copy `_backup/` into the new bucket, verify counts, delete the old prefix.
3. Run `scripts/backup.sh` once and confirm it writes to the new bucket.
4. Run the restore drill; record counts in `infra/README.md`.
5. Rewrite the README "Backups" section around the three layers, the new bucket,
   the PITR-creates-a-new-table caveat, and the irreversibility of versioning.

## Out of scope

- Cross-region or cross-account copies.
- A third copy of the books (depends on whether the local 89 GB is itself backed
  up — a separate decision).
- A heartbeat alarm for a schedule that never fires.
- Re-import tooling for the JSON exports; PITR is the restore path.
