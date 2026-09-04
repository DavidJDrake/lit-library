import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { Api } from "../lib/api";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const userPool = new cognito.UserPool(stack, "Pool");
  const client = userPool.addClient("Client");
  new Api(stack, "Api", {
    config, userPool, client, keyPairId: "K2EXAMPLE",
    booksBucket: new s3.Bucket(stack, "Books"),
    siteBucket: new s3.Bucket(stack, "Site"),
  });
  return Template.fromStack(stack);
}

describe("Api", () => {
  it("creates a retained on-demand downloads table keyed by email/sk", () => {
    const t = synth();
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      }),
    });
  });

  it("wires the download Lambda with least-privilege grants", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: Match.objectLike({ BOOKS_BUCKET: Match.anyValue(), SITE_BUCKET: Match.anyValue(), DOWNLOADS_TABLE: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([
        Match.objectLike({ Action: "s3:GetObject" }),
        Match.objectLike({ Action: "dynamodb:PutItem" }),
      ]) }),
    });
  });

  it("wires the session Lambda with the signing secret, site domain, and key pair id", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: Match.objectLike({
        SIGNING_KEY_SECRET_NAME: config.signingKeySecretName, SITE_DOMAIN: config.siteDomain, KEY_PAIR_ID: "K2EXAMPLE",
      }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith(["secretsmanager:GetSecretValue"]) }),
      ]) }),
    });
  });

  it("exposes the /api routes: JWT on download and session GET, none on session DELETE; no CORS", () => {
    const t = synth();
    const api = Object.values(t.findResources("AWS::ApiGatewayV2::Api"))[0] as { Properties: Record<string, unknown> };
    expect(api.Properties.CorsConfiguration).toBeUndefined();
    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r as { Properties: { RouteKey: string; AuthorizationType: string } }).Properties);
    const byKey = Object.fromEntries(routes.map((r) => [r.RouteKey, r.AuthorizationType]));
    expect(byKey).toEqual({ "POST /api/download": "JWT", "GET /api/session": "JWT", "DELETE /api/session": "NONE" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      JwtConfiguration: Match.objectLike({ Audience: [Match.anyValue()], Issuer: Match.anyValue() }),
    });
  });
});
