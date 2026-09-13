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
