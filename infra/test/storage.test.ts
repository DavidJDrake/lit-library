import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { Storage } from "../lib/storage";

function synth() {
  const stack = new Stack(new App(), "Test");
  new Storage(stack, "Storage");
  return Template.fromStack(stack);
}

describe("Storage", () => {
  it("creates exactly two private buckets", () => {
    const t = synth();
    t.resourceCountIs("AWS::S3::Bucket", 2);
    t.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  it("books bucket is retained and transitions to Intelligent-Tiering immediately", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: "Enabled",
              Transitions: [{ StorageClass: "INTELLIGENT_TIERING", TransitionInDays: 0 }],
            }),
          ]),
        },
      }),
    });
  });

  it("site bucket is deleted with the stack", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    t.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });

  it("enforces SSL on both buckets", () => {
    const t = synth();
    t.resourceCountIs("AWS::S3::BucketPolicy", 2);
    t.allResourcesProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      }),
    });
  });
});
