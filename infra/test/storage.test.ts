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

  it("site bucket is deleted with the stack", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    t.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });

  it("enforces SSL on every bucket", () => {
    const t = synth();
    t.resourceCountIs("AWS::S3::BucketPolicy", 3);
    t.allResourcesProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      }),
    });
  });
});
