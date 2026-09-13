import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { logEvent } from "../shared/log";
import { exportTables, type BackupDeps } from "./export";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type ScanClient = { send: DynamoDBClient["send"] };
type PutClient = { send: S3Client["send"] };

/**
 * Builds the real BackupDeps from AWS SDK clients. Exported (rather than only
 * built at module scope) so tests can exercise this adapter — the only place
 * ExclusiveStartKey/LastEvaluatedKey passthrough can be dropped — against a
 * fake client instead of a real DynamoDB table.
 *
 * Uses the raw client-dynamodb ScanCommand, not the lib-dynamodb document
 * client: this must emit AttributeValue-annotated items
 * ({"pk":{"S":"..."}}), the same shape `aws dynamodb scan --output json`
 * writes, so scripts/backup.sh and this Lambda produce files one restore
 * procedure can read interchangeably.
 */
export function makeDeps(ddb: ScanClient, s3: PutClient, bucket: string): BackupDeps {
  return {
    scan: async (table, startKey) => {
      const out = await ddb.send(new ScanCommand({
        TableName: table,
        ExclusiveStartKey: startKey as Record<string, AttributeValue> | undefined,
      }));
      return {
        Items: (out.Items ?? []) as Record<string, unknown>[],
        LastEvaluatedKey: out.LastEvaluatedKey,
      };
    },
    put: async (key, body) => {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: "application/json",
      }));
    },
    now: () => new Date(),
  };
}

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

// Errors are deliberately not caught: a failed backup must surface as a Lambda
// error so the Errors alarm fires. Reporting success here would be worse than
// not running at all.
export async function handler(): Promise<{ ok: true; counts: Record<string, number> }> {
  const deps = makeDeps(ddb, s3, env("BACKUP_BUCKET"));
  const counts = await exportTables([
    { table: env("LIBRARY_TABLE"), name: "library" },
    { table: env("DOWNLOADS_TABLE"), name: "downloads" },
  ], deps);
  logEvent("backup.complete", counts);
  return { ok: true, counts };
}
