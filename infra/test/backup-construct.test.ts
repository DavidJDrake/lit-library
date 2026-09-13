import { App, CfnElement, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { Backup } from "../lib/backup";

interface Statement { Action: string | string[]; Effect: string; Resource: unknown }

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
  });
  const libraryTable = table("Library");
  const downloadsTable = table("Downloads");
  const backupBucket = new s3.Bucket(stack, "BackupBucket");
  // Not passed to Backup at all — stands in for the bucket Backup must never touch,
  // so a stray grant on it (e.g. a copy-pasted `grantPut`) has something to fail against.
  const booksBucket = new s3.Bucket(stack, "BooksBucket");
  const backup = new Backup(stack, "Backup", { libraryTable, downloadsTable, backupBucket });
  return { t: Template.fromStack(stack), stack, libraryTable, downloadsTable, backupBucket, booksBucket, backup };
}

/** The IAM::Policy resource attached to the role with this logical id. */
function statementsForRole(t: Template, roleLogicalId: string): Statement[] {
  const policies = Object.values(t.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref: string }> };
  }>;
  const policy = policies.find((p) => p.Properties.Roles.some((r) => r.Ref === roleLogicalId));
  if (!policy) throw new Error(`no IAM::Policy attached to role ${roleLogicalId}`);
  return policy.Properties.PolicyDocument.Statement;
}

function actionsOf(s: Statement): string[] {
  return Array.isArray(s.Action) ? s.Action : [s.Action];
}

/** Does this statement's Resource mention the given logical id (via Ref, Fn::GetAtt, or Fn::Join)? */
function resourceMentions(s: Statement, logicalId: string): boolean {
  return JSON.stringify(s.Resource).includes(logicalId);
}

describe("Backup", () => {
  it("runs the export weekly, targeting the backup function specifically", () => {
    const { t, stack, backup } = synth();
    const fnLogicalId = stack.getLogicalId(backup.fn.node.defaultChild as CfnElement);
    t.resourceCountIs("AWS::Events::Rule", 1);
    t.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(7 days)",
      State: "ENABLED",
      Targets: [Match.objectLike({ Arn: { "Fn::GetAtt": [fnLogicalId, "Arn"] } })],
    });
  });

  it("points each environment variable at its own table, not the other one", () => {
    const { t, stack, libraryTable, downloadsTable } = synth();
    const libraryLogicalId = stack.getLogicalId(libraryTable.node.defaultChild as CfnElement);
    const downloadsLogicalId = stack.getLogicalId(downloadsTable.node.defaultChild as CfnElement);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: {
        Variables: Match.objectLike({
          LIBRARY_TABLE: { Ref: libraryLogicalId },
          DOWNLOADS_TABLE: { Ref: downloadsLogicalId },
          BACKUP_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it("can read both tables and put to the backup bucket, but never delete, write a row, or touch the books bucket", () => {
    const { t, stack, libraryTable, downloadsTable, backupBucket, booksBucket, backup } = synth();
    const roleLogicalId = stack.getLogicalId((backup.fn.role!).node.defaultChild as CfnElement);
    const libraryLogicalId = stack.getLogicalId(libraryTable.node.defaultChild as CfnElement);
    const downloadsLogicalId = stack.getLogicalId(downloadsTable.node.defaultChild as CfnElement);
    const backupBucketLogicalId = stack.getLogicalId(backupBucket.node.defaultChild as CfnElement);
    const booksBucketLogicalId = stack.getLogicalId(booksBucket.node.defaultChild as CfnElement);

    const statements = statementsForRole(t, roleLogicalId);

    // Each table gets its own read grant, tied to its own resource — not just
    // "dynamodb:Scan appears somewhere", which would pass even if only one
    // table were actually granted.
    for (const logicalId of [libraryLogicalId, downloadsLogicalId]) {
      const forTable = statements.filter((s) => resourceMentions(s, logicalId));
      expect(forTable.length).toBeGreaterThan(0);
      expect(forTable.some((s) => actionsOf(s).includes("dynamodb:Scan"))).toBe(true);
    }

    // The backup bucket gets a put grant, tied to its own resource.
    const forBackupBucket = statements.filter((s) => resourceMentions(s, backupBucketLogicalId));
    expect(forBackupBucket.length).toBeGreaterThan(0);
    expect(forBackupBucket.some((s) => actionsOf(s).includes("s3:PutObject"))).toBe(true);

    // No statement anywhere grants a wildcard (which would confer delete while
    // still passing a substring check for the read/put actions above) or a
    // delete/write action on either table or the bucket — matched by prefix,
    // not exact string, so CDK's own wildcard suffixes (e.g. `s3:DeleteObject*`
    // from a copy-pasted `grantReadWrite`) can't slip past an exact-match check.
    const forbiddenActions = [
      /^\*$/, /^s3:\*$/, /^dynamodb:\*$/,
      /^s3:Delete/, /^dynamodb:Delete/, /^dynamodb:Put/, /^dynamodb:Update/,
    ];
    for (const s of statements) {
      for (const action of actionsOf(s)) {
        for (const pattern of forbiddenActions) {
          expect(pattern.test(action), `action "${action}" matches forbidden pattern ${pattern}`).toBe(false);
        }
      }
    }

    // Books bucket: no grant at all — the spec requires the backup function
    // reach only the backup bucket, never the books bucket.
    expect(statements.some((s) => resourceMentions(s, booksBucketLogicalId))).toBe(false);
  });
});
