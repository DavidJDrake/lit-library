# Backup Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the state that cannot be regenerated survive the loss of the books bucket, with continuous recovery for reader data and a restore that has actually been run.

**Architecture:** Three layers matched to how each dataset changes — DynamoDB point-in-time recovery for the two tables (continuous, 35 days), `metadata/` backed up when `publish-new.sh` changes it, and a weekly EventBridge-driven Lambda that exports both tables. Backups move out of the books bucket into a separate versioned bucket, and the books bucket gains versioning so a bad delete is reversible.

**Tech Stack:** AWS CDK v2 (aws-cdk-lib 2.268), TypeScript, Node 22 Lambdas (`NodejsFunction`), vitest with `aws-cdk-lib/assertions`, bash scripts, AWS CLI.

**Spec:** `docs/superpowers/specs/2026-09-12-backup-resilience-design.md`

## Global Constraints

- Region is `us-east-1`; stack name is `EbookShare`. AWS CLI calls need `AWS_REGION=us-east-1` — the shell default in this environment is a different region.
- Use `pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }`. The boolean `pointInTimeRecovery` prop is **deprecated** in aws-cdk-lib 2.268 and must not be used.
- Lambda runtime is `lambda.Runtime.NODEJS_22_X`, `logRetention: logs.RetentionDays.ONE_MONTH`, matching every other function in `infra/lib/`.
- CDK construct ids must never be renamed after first deploy (`infra/README.md` keeps a list). New ids introduced here: `Storage/Backup` (bucket), `Backup` (stack-level construct), `Backup/Fn`, `Backup/Weekly`.
- The export Lambda gets **read** on the tables and **put** on the backup bucket. Never grant delete.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk
  ```
- Run infra tests with `cd infra && npx vitest run`, typecheck with `npm run typecheck`. Both must pass before every commit.
- Branch: `backup-resilience`. Worktree: `.worktrees/backup-epic`.

---

### Task 1: Backup bucket

**Files:**
- Modify: `infra/lib/storage.ts`
- Modify: `infra/lib/ebook-share-stack.ts` (outputs block at the end)
- Test: `infra/test/storage.test.ts`, `infra/test/stack.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Storage.backupBucket: s3.Bucket` — used by Task 6 (`grantPut`) and by the `BackupBucketName` stack output that Task 8's script reads.

- [ ] **Step 1: Write the failing tests**

In `infra/test/storage.test.ts`, change the existing bucket-count test and add a new one. The existing test currently reads `t.resourceCountIs("AWS::S3::Bucket", 2)` inside `it("creates exactly two private buckets")` — rename it and bump the count:

```ts
  it("creates exactly three private buckets", () => {
    const t = synth();
    t.resourceCountIs("AWS::S3::Bucket", 3);
    t.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  it("backup bucket is versioned, retained, and keeps old versions for 90 days", () => {
    const t = synth();
    // Identified by its 90-day noncurrent rule: the books bucket uses 30 (Task 2).
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: "Enabled",
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            }),
          ]),
        },
      }),
    });
  });
```

Also update the SSL test in the same file — it asserts `t.resourceCountIs("AWS::S3::BucketPolicy", 2)` under `it("enforces SSL on both buckets")`. Rename to `"enforces SSL on every bucket"` and change the count to `3`.

In `infra/test/stack.test.ts`, line ~21 change `t.resourceCountIs("AWS::S3::Bucket", 2)` to `3`, and add `"BackupBucketName"` to the list of output names in the `it("exports every value the indexer and the SPA need")` test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd infra && npx vitest run test/storage.test.ts test/stack.test.ts`
Expected: FAIL — bucket count is 2, not 3; no bucket matches the 90-day noncurrent rule; `BackupBucketName` output missing.

- [ ] **Step 3: Add the bucket**

In `infra/lib/storage.ts`, add the field beside the other two:

```ts
  readonly backupBucket: s3.Bucket;
```

and create it after `siteBucket` inside the constructor:

```ts
    // Backups live outside the bucket they protect: a bad sync or a recursive delete
    // in Books must not be able to take the backups with it.
    this.backupBucket = new s3.Bucket(this, "Backup", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [
        {
          // Small objects; keep a quarter of history and clean up failed uploads.
          noncurrentVersionExpiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      // No Intelligent-Tiering rule: these objects are mostly under the 128 KB
      // auto-tiering floor, so a transition would add reporting noise and no saving.
    });
```

In `infra/lib/ebook-share-stack.ts`, add one output beside the others:

```ts
    new CfnOutput(this, "BackupBucketName", { value: storage.backupBucket.bucketName });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd infra && npx vitest run test/storage.test.ts test/stack.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/storage.ts infra/lib/ebook-share-stack.ts infra/test/storage.test.ts infra/test/stack.test.ts
git commit -m "feat(infra): separate versioned backup bucket

Backups currently live in a _backup/ prefix inside the books bucket they
protect. Give them their own retained, versioned bucket with a 90-day
noncurrent expiry, exported as BackupBucketName.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 2: Books bucket versioning

**Files:**
- Modify: `infra/lib/storage.ts` (the `booksBucket` definition)
- Test: `infra/test/storage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks; changes runtime recovery behaviour only.

- [ ] **Step 1: Write the failing test**

Add to `infra/test/storage.test.ts`:

```ts
  it("books bucket keeps deleted or overwritten books recoverable for 30 days", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: "Enabled",
              // Same rule still carries the Intelligent-Tiering transition.
              Transitions: [{ StorageClass: "INTELLIGENT_TIERING", TransitionInDays: 0 }],
              NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            }),
          ]),
        },
      }),
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd infra && npx vitest run test/storage.test.ts -t "recoverable for 30 days"`
Expected: FAIL — the books bucket has no `VersioningConfiguration` and no noncurrent expiry.

- [ ] **Step 3: Enable versioning on the books bucket**

In `infra/lib/storage.ts`, inside the existing `booksBucket` definition add `versioned: true` and extend the existing lifecycle rule:

```ts
      versioned: true,
      lifecycleRules: [
        {
          // The indexer already uploads with StorageClass=INTELLIGENT_TIERING;
          // this catches anything uploaded by other means.
          transitions: [
            { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) },
          ],
          // An accidental delete (a mis-pointed `prune --delete`, a bad sync) stays
          // recoverable for 30 days, then stops costing anything.
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd infra && npx vitest run test/storage.test.ts && npm run typecheck`
Expected: PASS — including the Task 1 backup-bucket test, which still matches only the 90-day rule.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/storage.ts infra/test/storage.test.ts
git commit -m "feat(infra): version the books bucket with a 30-day noncurrent expiry

Makes an accidental delete recoverable. Books are write-once, so steady
state adds nothing; the expiry caps a mass-delete at one month of storage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 3: Point-in-time recovery on both tables

**Files:**
- Modify: `infra/lib/library.ts` (the `Table` definition), `infra/lib/api.ts` (the `Downloads` definition)
- Test: `infra/test/library.test.ts`, `infra/test/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

In `infra/test/library.test.ts`, the existing table assertion (around line 35) becomes:

```ts
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
```

In `infra/test/api.test.ts`, the equivalent assertion (around line 26):

```ts
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd infra && npx vitest run test/library.test.ts test/api.test.ts`
Expected: FAIL — no `PointInTimeRecoverySpecification` in either template.

- [ ] **Step 3: Enable PITR**

In `infra/lib/library.ts`, inside `new dynamodb.Table(this, "Table", { ... })` add as the last property:

```ts
      // Continuous 35-day recovery for the only data that exists nowhere else.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
```

In `infra/lib/api.ts`, inside `new dynamodb.Table(this, "Downloads", { ... })` add the same line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd infra && npx vitest run test/library.test.ts test/api.test.ts && npm run typecheck`
Expected: PASS. If TypeScript reports `pointInTimeRecovery` as deprecated, the wrong property was used — see Global Constraints.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/library.ts infra/lib/api.ts infra/test/library.test.ts infra/test/api.test.ts
git commit -m "feat(infra): enable point-in-time recovery on both tables

Reading statuses, category edits, suggestions, Kindle devices and OPDS
token hashes exist nowhere else and had no restore path. PITR gives
continuous 35-day recovery for about \$0.000003/month.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 4: Export logic (pure, dependency-injected)

**Files:**
- Create: `infra/lambda/backup/export.ts`
- Test: `infra/test/backup-export.test.ts`

**Interfaces:**
- Consumes: `logEvent(name, fields)` from `infra/lambda/shared/log.ts`.
- Produces:
  - `stamp(d: Date): string` — `"2026-09-12T014530Z"`, matching `date -u +%Y-%m-%dT%H%M%SZ` in `scripts/backup.sh`.
  - `scanAll(scan: ScanFn, table: string): Promise<Record<string, unknown>[]>`
  - `exportTables(targets: TableTarget[], deps: BackupDeps): Promise<Record<string, number>>` returning `{ library: 106, downloads: 9 }`-shaped counts.
  - Types `ScanPage`, `ScanFn`, `PutFn`, `BackupDeps`, `TableTarget` — Task 5 implements `ScanFn`/`PutFn` against the real SDK.

- [ ] **Step 1: Write the failing test**

Create `infra/test/backup-export.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { exportTables, scanAll, stamp, type ScanFn } from "../lambda/backup/export";

const AT = new Date("2026-09-12T01:45:30.000Z");

describe("stamp", () => {
  it("matches the shell script's date -u +%Y-%m-%dT%H%M%SZ format", () => {
    expect(stamp(AT)).toBe("2026-09-12T014530Z");
  });
});

describe("scanAll", () => {
  it("follows LastEvaluatedKey until the table is exhausted", async () => {
    const pages = [
      { Items: [{ pk: "a" }], LastEvaluatedKey: { pk: "a" } },
      { Items: [{ pk: "b" }], LastEvaluatedKey: { pk: "b" } },
      { Items: [{ pk: "c" }] },
    ];
    const seen: (Record<string, unknown> | undefined)[] = [];
    const scan: ScanFn = async (_table, startKey) => {
      seen.push(startKey);
      return pages[seen.length - 1];
    };
    await expect(scanAll(scan, "T")).resolves.toEqual([{ pk: "a" }, { pk: "b" }, { pk: "c" }]);
    expect(seen).toEqual([undefined, { pk: "a" }, { pk: "b" }]);
  });
});

describe("exportTables", () => {
  it("writes one stamped object per table in the same shape as `aws dynamodb scan`", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const scan: ScanFn = async (table) => ({ Items: table === "lib" ? [{ pk: "x" }, { pk: "y" }] : [{ pk: "z" }] });
    const counts = await exportTables(
      [{ table: "lib", name: "library" }, { table: "dl", name: "downloads" }],
      { scan, put, now: () => AT },
    );
    expect(counts).toEqual({ library: 2, downloads: 1 });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith("dynamodb/library-2026-09-12T014530Z.json",
      JSON.stringify({ Items: [{ pk: "x" }, { pk: "y" }], Count: 2 }));
    expect(put).toHaveBeenCalledWith("dynamodb/downloads-2026-09-12T014530Z.json",
      JSON.stringify({ Items: [{ pk: "z" }], Count: 1 }));
  });

  it("propagates a failed scan instead of reporting success", async () => {
    const scan: ScanFn = async () => { throw new Error("ddb down"); };
    await expect(exportTables([{ table: "lib", name: "library" }],
      { scan, put: vi.fn(), now: () => AT })).rejects.toThrow("ddb down");
  });

  it("propagates a failed put instead of reporting success", async () => {
    const scan: ScanFn = async () => ({ Items: [] });
    const put = vi.fn().mockRejectedValue(new Error("no such bucket"));
    await expect(exportTables([{ table: "lib", name: "library" }],
      { scan, put, now: () => AT })).rejects.toThrow("no such bucket");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd infra && npx vitest run test/backup-export.test.ts`
Expected: FAIL — cannot resolve `../lambda/backup/export`.

- [ ] **Step 3: Write the implementation**

Create `infra/lambda/backup/export.ts`:

```ts
import { logEvent } from "../shared/log";

export interface ScanPage {
  Items: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}
export type ScanFn = (table: string, startKey?: Record<string, unknown>) => Promise<ScanPage>;
export type PutFn = (key: string, body: string) => Promise<void>;
export interface BackupDeps { scan: ScanFn; put: PutFn; now: () => Date }
/** `table` is the physical table name; `name` is the filename prefix in the bucket. */
export interface TableTarget { table: string; name: string }

/** "2026-09-12T014530Z" — the format scripts/backup.sh writes, so both producers agree. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
}

/** A scan that stops at the first page is a backup that silently lies; follow every key. */
export async function scanAll(scan: ScanFn, table: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await scan(table, startKey);
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export async function exportTables(targets: TableTarget[], deps: BackupDeps): Promise<Record<string, number>> {
  const at = stamp(deps.now());
  const counts: Record<string, number> = {};
  for (const target of targets) {
    const items = await scanAll(deps.scan, target.table);
    const key = `dynamodb/${target.name}-${at}.json`;
    // Same shape as `aws dynamodb scan --output json`, so one restore procedure
    // covers files written by this Lambda or by scripts/backup.sh.
    await deps.put(key, JSON.stringify({ Items: items, Count: items.length }));
    counts[target.name] = items.length;
    logEvent("backup.exported", { table: target.name, rows: items.length, key });
  }
  return counts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd infra && npx vitest run test/backup-export.test.ts && npm run typecheck`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/backup/export.ts infra/test/backup-export.test.ts
git commit -m "feat(backup): table export logic with paginated scans

Pure and dependency-injected, like the other handlers here. Output shape
matches \`aws dynamodb scan --output json\` so one restore procedure covers
files from either producer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 5: Export handler wiring

**Files:**
- Create: `infra/lambda/backup/index.ts`

**Interfaces:**
- Consumes: `exportTables`, `BackupDeps` from Task 4.
- Produces: `handler()` — the Lambda entry point Task 6 points `NodejsFunction` at. Reads `LIBRARY_TABLE`, `DOWNLOADS_TABLE`, `BACKUP_BUCKET` from the environment.

- [ ] **Step 1: Write the implementation**

There is no unit test for this file: it is pure SDK wiring with no branching, exactly like the wiring half of the other handlers, and Task 4 covers the logic. Its correctness is verified end-to-end in Task 7 by invoking the deployed function.

Create `infra/lambda/backup/index.ts`:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { logEvent } from "../shared/log";
import { exportTables, type BackupDeps } from "./export";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const deps: BackupDeps = {
  scan: async (table, startKey) => {
    const out = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: startKey }));
    return {
      Items: (out.Items ?? []) as Record<string, unknown>[],
      LastEvaluatedKey: out.LastEvaluatedKey,
    };
  },
  put: async (key, body) => {
    await s3.send(new PutObjectCommand({
      Bucket: env("BACKUP_BUCKET"), Key: key, Body: body, ContentType: "application/json",
    }));
  },
  now: () => new Date(),
};

// Errors are deliberately not caught: a failed backup must surface as a Lambda
// error so the Errors alarm fires. Reporting success here would be worse than
// not running at all.
export async function handler(): Promise<{ ok: true; counts: Record<string, number> }> {
  const counts = await exportTables([
    { table: env("LIBRARY_TABLE"), name: "library" },
    { table: env("DOWNLOADS_TABLE"), name: "downloads" },
  ], deps);
  logEvent("backup.complete", counts);
  return { ok: true, counts };
}
```

- [ ] **Step 2: Verify it compiles and nothing regressed**

Run: `cd infra && npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add infra/lambda/backup/index.ts
git commit -m "feat(backup): Lambda entry point for the weekly export

Errors propagate so a failed run reaches the Errors alarm rather than
reporting a success that never happened.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 6: Backup construct, weekly schedule, and alarm

**Files:**
- Create: `infra/lib/backup.ts`
- Modify: `infra/lib/ebook-share-stack.ts` (after the `Alerts` construct)
- Test: `infra/test/backup-construct.test.ts`, `infra/test/stack.test.ts`

**Interfaces:**
- Consumes: `Storage.backupBucket` (Task 1); `infra/lambda/backup/index.ts` (Task 5); `alerts.watch(fn)` from `infra/lib/alerts.ts`.
- Produces: `Backup` construct with `readonly fn: NodejsFunction`.

- [ ] **Step 1: Write the failing tests**

Create `infra/test/backup-construct.test.ts`:

```ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { Backup } from "../lib/backup";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
  });
  new Backup(stack, "Backup", {
    libraryTable: table("Library"),
    downloadsTable: table("Downloads"),
    backupBucket: new s3.Bucket(stack, "BackupBucket"),
  });
  return Template.fromStack(stack);
}

describe("Backup", () => {
  it("runs the export weekly", () => {
    const t = synth();
    t.resourceCountIs("AWS::Events::Rule", 1);
    t.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(7 days)",
      State: "ENABLED",
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
  });

  it("passes both table names and the bucket to the function", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: {
        Variables: Match.objectLike({
          LIBRARY_TABLE: Match.anyValue(),
          DOWNLOADS_TABLE: Match.anyValue(),
          BACKUP_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it("can read the tables and add objects, but never delete one", () => {
    const t = synth();
    // Grant actions render differently across CDK versions, so assert on the
    // rendered policy text rather than an exact action array.
    const policies = JSON.stringify(Object.values(t.findResources("AWS::IAM::Policy")));
    expect(policies).toContain("dynamodb:Scan");
    expect(policies).toContain("s3:PutObject");
    expect(policies).not.toContain("s3:DeleteObject");
    expect(policies).not.toContain("dynamodb:DeleteItem");
    expect(policies).not.toContain("dynamodb:PutItem");
  });
});
```

In `infra/test/stack.test.ts`, the alarm-count assertion around line 92 (`expect(alarms).toHaveLength(7)`) becomes `8`, because the backup function gets an Errors alarm like every other function.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd infra && npx vitest run test/backup-construct.test.ts test/stack.test.ts`
Expected: FAIL — cannot resolve `../lib/backup`; stack still has 7 alarms.

- [ ] **Step 3: Write the construct and wire it into the stack**

Create `infra/lib/backup.ts`:

```ts
import { Duration } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "node:path";

export interface BackupProps {
  libraryTable: dynamodb.ITable;
  downloadsTable: dynamodb.ITable;
  backupBucket: s3.IBucket;
}

// Weekly export of the two tables PITR already protects continuously — a readable
// snapshot that survives PITR being turned off, and a second producer of the same
// file format scripts/backup.sh writes.
// See docs/superpowers/specs/2026-09-12-backup-resilience-design.md.
export class Backup extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: BackupProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/backup/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        LIBRARY_TABLE: props.libraryTable.tableName,
        DOWNLOADS_TABLE: props.downloadsTable.tableName,
        BACKUP_BUCKET: props.backupBucket.bucketName,
      },
    });

    props.libraryTable.grantReadData(this.fn);
    props.downloadsTable.grantReadData(this.fn);
    // Put only. A bug or a compromise here can add a backup, never remove one.
    props.backupBucket.grantPut(this.fn);

    new events.Rule(this, "Weekly", {
      description: "Export both DynamoDB tables to the backup bucket",
      schedule: events.Schedule.rate(Duration.days(7)),
      targets: [new targets.LambdaFunction(this.fn)],
    });
  }
}
```

In `infra/lib/ebook-share-stack.ts`, import it beside the other constructs:

```ts
import { Backup } from "./backup";
```

and add after the `alerts.watch(kindle.eventsFn);` line:

```ts
    const backup = new Backup(this, "Backup", {
      libraryTable: library.table,
      downloadsTable: api.table,
      backupBucket: storage.backupBucket,
    });
    alerts.watch(backup.fn);
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `cd infra && npx vitest run && npm run typecheck`
Expected: PASS across all test files, including the updated stack counts.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/backup.ts infra/lib/ebook-share-stack.ts infra/test/backup-construct.test.ts infra/test/stack.test.ts
git commit -m "feat(infra): weekly table export to the backup bucket

EventBridge rule and a Lambda that scans both tables into the backup
bucket, with read-only table access and put-only bucket access. Errors
email through the existing SNS topic via alerts.watch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 7: Deploy and verify in the account

**Files:** none (deployment task)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `BackupBucketName` in `infra/outputs.json`, which Task 8 reads.

> **Ask the user before running this task.** It changes live infrastructure. Enabling versioning on the books bucket cannot be undone (only suspended).

- [ ] **Step 1: Review the change set**

Run: `cd infra && npx cdk diff 2>&1 | grep -v "logRetention is deprecated"`
Expected: a new S3 bucket, a new Lambda plus its role and log group, an Events rule and its permission, one new alarm, `PointInTimeRecoverySpecification` on both tables, `VersioningConfiguration` on the books bucket. No table or bucket **replacement** — if the diff shows a replacement, stop and report it.

- [ ] **Step 2: Deploy**

Run: `cd infra && npm run deploy`
Expected: `✅  EbookShare`.

- [ ] **Step 3: Verify PITR is really on**

```bash
export AWS_REGION=us-east-1
for t in $(python3 -c "import json;o=next(iter(json.load(open('infra/outputs.json')).values()));print(o['LibraryTable'], o['DownloadsTable'])"); do
  echo "$t: $(aws dynamodb describe-continuous-backups --table-name "$t" \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)"
done
```
Expected: `ENABLED` for both.

- [ ] **Step 4: Invoke the export function once, rather than waiting a week**

```bash
export AWS_REGION=us-east-1
FN=$(aws cloudformation describe-stack-resources --stack-name EbookShare \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'&&contains(LogicalResourceId,'Backup')].PhysicalResourceId" --output text)
aws lambda invoke --function-name "$FN" /tmp/backup-out.json >/dev/null && cat /tmp/backup-out.json
BUCKET=$(python3 -c "import json;print(next(iter(json.load(open('infra/outputs.json')).values()))['BackupBucketName'])")
aws s3 ls "s3://$BUCKET/dynamodb/"
```
Expected: `{"ok":true,"counts":{"library":<n>,"downloads":<m>}}` where the counts match the live tables, and two stamped JSON files listed.

- [ ] **Step 5: Confirm versioning is on both buckets**

```bash
export AWS_REGION=us-east-1
python3 -c "import json;o=next(iter(json.load(open('infra/outputs.json')).values()));print(o['BooksBucketName']);print(o['BackupBucketName'])" | \
  while read -r b; do echo "$b: $(aws s3api get-bucket-versioning --bucket "$b" --query Status --output text)"; done
```
Expected: `Enabled` for both.

---

### Task 8: Point `backup.sh` at the backup bucket

**Files:**
- Modify: `scripts/backup.sh`

**Interfaces:**
- Consumes: the `BackupBucketName` output (Task 7).
- Produces: backups written to `s3://<backup bucket>/` with the same prefixes as before.

- [ ] **Step 1: Change the destination and fail loudly without the output**

In `scripts/backup.sh`, replace these two lines:

```bash
read -r BUCKET TABLE LIBTABLE < <(python3 -c "import json;o=next(iter(json.load(open('$ROOT/infra/outputs.json')).values()));print(o['BooksBucketName'], o['DownloadsTable'], o.get('LibraryTable',''))")
DEST="s3://$BUCKET/_backup"
```

with:

```bash
# Assign through a variable, not process substitution: `read < <(cmd)` discards the
# command's exit status, so a missing output would sail past `set -e`.
RESOURCES=$(python3 -c "
import json, sys
o = next(iter(json.load(open('$ROOT/infra/outputs.json')).values()))
bucket = o.get('BackupBucketName')
if not bucket:
    sys.exit('outputs.json has no BackupBucketName - deploy the stack before backing up')
print(bucket, o['DownloadsTable'], o.get('LibraryTable', ''))
")
read -r BUCKET TABLE LIBTABLE <<<"$RESOURCES"
# Never fall back to the books bucket: backups sharing a bucket with the data they
# protect is the problem this replaced.
DEST="s3://$BUCKET"
```

- [ ] **Step 2: Verify the dry run names the new bucket**

Run: `cd /home/jay/projects/ebook-share && scripts/backup.sh --dry-run | head -5`
Expected: paths beginning `s3://<backup bucket>/metadata/`, with no `_backup` segment.

- [ ] **Step 3: Verify it refuses when the output is missing**

```bash
cd /home/jay/projects/ebook-share
cp -a infra/outputs.json /tmp/outputs-real.json
python3 -c "
import json
p = 'infra/outputs.json'
d = json.load(open(p))
k = next(iter(d))
d[k].pop('BackupBucketName', None)
json.dump(d, open(p, 'w'), indent=2)
"
scripts/backup.sh --dry-run; echo "exit: $?"
cp -a /tmp/outputs-real.json infra/outputs.json
cmp infra/outputs.json /tmp/outputs-real.json && echo "outputs.json restored intact"
```
Expected: the message `outputs.json has no BackupBucketName - deploy the stack before backing up`, a non-zero exit, then `outputs.json restored intact`.

- [ ] **Step 4: Run a real backup**

Run: `cd /home/jay/projects/ebook-share && scripts/backup.sh`
Expected: `backup complete: s3://<backup bucket>`, with row counts for both tables.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup.sh
git commit -m "feat(scripts): back up to the dedicated bucket

Reads BackupBucketName and refuses to run without it rather than falling
back to the books bucket. Assigns through a variable so a failure is not
swallowed by process substitution.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 9: Back up `metadata/` on publish

**Files:**
- Modify: `scripts/publish-new.sh`

**Interfaces:**
- Consumes: `scripts/backup.sh` (Task 8).
- Produces: nothing consumed later.

- [ ] **Step 1: Call the backup as the last step**

Append to `scripts/publish-new.sh`, after the `notify-books-added.py` line:

```bash
# metadata/ only changes when a publish changes it, so this is the moment to back it
# up. A failed backup must not fail the publish: the books are already live.
"$ROOT/scripts/backup.sh" || echo "WARNING: backup failed - run scripts/backup.sh by hand" >&2
```

- [ ] **Step 2: Verify a publish now ends with a backup**

Run: `cd /home/jay/projects/ebook-share && scripts/publish-new.sh 2>&1 | tail -6`
Expected: `new books: 0`, the publish lines, then `backup complete: s3://<backup bucket>`.

- [ ] **Step 3: Commit**

```bash
git add scripts/publish-new.sh
git commit -m "feat(scripts): back up metadata after every publish

Publishing is the only thing that changes metadata/, so it is the right
trigger. A failed backup warns without failing a publish that already
put the books live.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

### Task 10: Migrate the old prefix, rehearse the restore, document it

**Files:**
- Modify: `infra/README.md` (the `## Backups` section, and the construct-ids list)
- Modify: `BACKLOG.md` (epic 28 checkboxes)

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: the documented, rehearsed restore procedure.

> **Ask the user before Step 2** (it deletes data from the books bucket).

- [ ] **Step 1: Copy the old `_backup/` prefix into the new bucket**

```bash
export AWS_REGION=us-east-1
cd /home/jay/projects/ebook-share
BOOKS=$(python3 -c "import json;print(next(iter(json.load(open('infra/outputs.json')).values()))['BooksBucketName'])")
BACKUP=$(python3 -c "import json;print(next(iter(json.load(open('infra/outputs.json')).values()))['BackupBucketName'])")
aws s3 cp --recursive "s3://$BOOKS/_backup/" "s3://$BACKUP/" --only-show-errors
echo "old: $(aws s3 ls --recursive "s3://$BOOKS/_backup/" | wc -l)  new: $(aws s3 ls --recursive "s3://$BACKUP/" | wc -l)"
```
Expected: the new count is at least the old count (the new bucket also holds the Task 7 export and the Task 8 run).

- [ ] **Step 2: Remove the old prefix (after asking)**

```bash
aws s3 rm --recursive "s3://$BOOKS/_backup/" --only-show-errors
aws s3 ls --recursive "s3://$BOOKS/_backup/" | wc -l
```
Expected: `0`. Note the objects are recoverable from their noncurrent versions for 30 days (Task 2).

- [ ] **Step 3: Rehearse the restore**

```bash
export AWS_REGION=us-east-1
cd /home/jay/projects/ebook-share
LIB=$(python3 -c "import json;print(next(iter(json.load(open('infra/outputs.json')).values()))['LibraryTable'])")
aws dynamodb restore-table-to-point-in-time --source-table-name "$LIB" \
  --target-table-name "${LIB}-drill" --use-latest-restorable-time >/dev/null
aws dynamodb wait table-exists --table-name "${LIB}-drill"
echo "live: $(aws dynamodb scan --table-name "$LIB" --select COUNT --query Count --output text)"
echo "drill: $(aws dynamodb scan --table-name "${LIB}-drill" --select COUNT --query Count --output text)"
```
Expected: the two counts match (106 at the time of writing). Record the numbers for the README.

- [ ] **Step 4: Delete the drill table**

```bash
aws dynamodb delete-table --table-name "${LIB}-drill" >/dev/null && echo deleted
```
Expected: `deleted`. Verify with `aws dynamodb list-tables --query 'TableNames'` that no `-drill` table remains.

- [ ] **Step 5: Rewrite the documentation**

Replace the `## Backups` section of `infra/README.md` so it describes: the three layers; that backups now live in their own versioned bucket, not `_backup/` inside the books bucket; that a PITR restore **creates a new table**, so recovery includes repointing the `LIBRARY_TABLE` / `DOWNLOADS_TABLE` environment variables; that the JSON exports are a readable secondary artifact rather than the primary restore path; that books-bucket versioning keeps deleted books recoverable for 30 days and **cannot be turned off, only suspended**; and the drill commands from Steps 3–4 with the counts observed.

Add `Storage/Backup`, `Backup`, `Backup/Fn` and `Backup/Weekly` to the "Construct IDs that must never be renamed after first deploy" section.

In `BACKLOG.md`, tick all four boxes under epic 28 and note the closing PR.

- [ ] **Step 6: Commit**

```bash
git add infra/README.md BACKLOG.md
git commit -m "docs: three-layer backups, with the restore rehearsed

Records what each layer restores, that a PITR restore creates a new table
and the Lambdas must be repointed, and the drill counts. Closes epic 28.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x8W1WWFhB1ep2ZJebiqmk"
```

---

## Notes for the reviewer

- **Deliberate limitation:** a schedule that never fires (a disabled rule) raises no alarm. The Errors alarm covers a crashing run. PITR is the continuous protection; a heartbeat metric was judged not worth the machinery at this size.
- **No test for `infra/lambda/backup/index.ts`:** it is SDK wiring with no branching, following the split used elsewhere; Task 4 tests the logic, Task 7 verifies the wiring against the real account.
- **Out of scope:** cross-region or cross-account copies, a third copy of the books, and re-import tooling for the JSON exports.
