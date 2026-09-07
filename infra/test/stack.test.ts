import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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
    t.resourceCountIs("AWS::DynamoDB::Table", 3);
    t.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
  });

  it("exports every value the indexer and the SPA need", () => {
    const t = synthStack();
    for (const name of [
      "SiteUrl", "SiteBucketName", "BooksBucketName", "DistributionId",
      "UserPoolId", "UserPoolClientId", "CognitoDomain", "ApiUrl", "DownloadsTable", "LibraryTable", "SigningKeyPairId",
      "NotificationsFunctionName", "KindleSender",
    ]) {
      expect(() => t.hasOutput(name, {})).not.toThrow();
    }
  });

  it("lets the notifications Lambda read the library table", () => {
    const t = synthStack();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), LIBRARY_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
  });

  // Every /api/* route must sit behind the real Cognito JWT authorizer, with a short,
  // explicit, individually justified exemption list — never a pattern match. A pattern
  // (e.g. "anything under /api/opds") would let a future unauthenticated route slip in
  // unnoticed just by sharing a path prefix with one of these two. Add to this set only
  // when the route authenticates itself some other way, and say how.
  const OPEN_ROUTES: ReadonlySet<string> = new Set([
    // Clears cookies only, so sign-out can still end the CloudFront session even after
    // the Cognito ID token itself is no longer valid.
    "DELETE /api/session",
    // A reader app has no way to obtain a Cognito token. Authenticates itself instead
    // with a per-reader, revocable, hashed bearer token carried as a query parameter and
    // checked inside the handler (infra/lambda/download/opds-store.ts) — read-only
    // catalogue access and nothing else; see infra/test/download-handler.test.ts.
    "GET /api/opds",
    "GET /api/opds/download/{bookId}/{format}",
  ]);

  it("points every GET/PUT/POST /api/* route's AuthorizerId at the stack's one JWT authorizer, except the explicitly exempted open routes", () => {
    const t = synthStack();
    const authorizerIds = Object.keys(t.findResources("AWS::ApiGatewayV2::Authorizer", { Properties: { AuthorizerType: "JWT" } }));
    expect(authorizerIds).toHaveLength(1);
    const jwtAuthorizerRef = { Ref: authorizerIds[0] };

    const routes = t.findResources("AWS::ApiGatewayV2::Route");
    const properties = Object.values(routes).map((r) => (r as { Properties: { RouteKey: string; AuthorizerId?: unknown } }).Properties);
    const authorized = properties.filter((p) => /^(GET|PUT|POST) \/api\//.test(p.RouteKey) && !OPEN_ROUTES.has(p.RouteKey));
    for (const p of authorized) {
      expect(p.AuthorizerId).toEqual(jwtAuthorizerRef);
    }
    expect(authorized.length).toBeGreaterThanOrEqual(13);

    // Every exempted route really exists and really has no authorizer — so the exemption
    // can't quietly hide a route that no longer needs it, or one that was never open at all.
    for (const key of OPEN_ROUTES) {
      const route = properties.find((p) => p.RouteKey === key);
      expect(route).toBeDefined();
      expect(route).not.toHaveProperty("AuthorizerId");
    }
  });

  it("alarms on errors from every function, including the two Kindle Lambdas", () => {
    const t = synthStack();
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm", {
      Properties: { Namespace: "AWS/Lambda", MetricName: "Errors" },
    }));
    expect(alarms).toHaveLength(7);
  });
});
