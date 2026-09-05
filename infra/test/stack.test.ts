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

  it("requires the JWT authorizer on every GET/PUT/POST /api/* route except DELETE /api/session", () => {
    const t = synthStack();
    const routes = t.findResources("AWS::ApiGatewayV2::Route");
    const properties = Object.values(routes).map((r) => (r as { Properties: { RouteKey: string; AuthorizerId?: unknown } }).Properties);
    const authorized = properties.filter((p) => /^(GET|PUT|POST) \/api\//.test(p.RouteKey));
    for (const p of authorized) {
      expect(p).toHaveProperty("AuthorizerId");
    }
    expect(authorized.length).toBeGreaterThanOrEqual(8);

    const deleteSession = properties.find((p) => p.RouteKey === "DELETE /api/session");
    expect(deleteSession).toBeDefined();
    expect(deleteSession).not.toHaveProperty("AuthorizerId");
  });
});
