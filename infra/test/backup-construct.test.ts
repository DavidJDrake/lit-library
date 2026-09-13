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
