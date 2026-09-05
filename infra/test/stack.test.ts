import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";
import { EbookShareStack } from "../lib/ebook-share-stack";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synthStack() {
  const app = new App();
  const stack = new EbookShareStack(app, "Test", {
    config,
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("EbookShareStack", () => {
  it("composes storage, site, auth, and api", () => {
    const t = synthStack();
    t.resourceCountIs("AWS::S3::Bucket", 2);
    t.resourceCountIs("AWS::CloudFront::Distribution", 1);
    t.resourceCountIs("AWS::Cognito::UserPool", 1);
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
  });

  it("exports every value the indexer and the SPA need", () => {
    const t = synthStack();
    for (const name of [
      "SiteUrl", "SiteBucketName", "BooksBucketName", "DistributionId",
      "UserPoolId", "UserPoolClientId", "CognitoDomain", "ApiUrl", "DownloadsTable", "LibraryTable", "SigningKeyPairId",
    ]) {
      expect(() => t.hasOutput(name, {})).not.toThrow();
    }
  });
});
