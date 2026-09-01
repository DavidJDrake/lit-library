import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, it } from "vitest";
import { Api } from "../lib/api";
import { CONFIG } from "../lib/config";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const userPool = new cognito.UserPool(stack, "Pool");
  const client = userPool.addClient("Client");
  new Api(stack, "Api", {
    userPool, client,
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
        KeySchema: [
          { AttributeName: "email", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    });
  });

  it("wires the download Lambda with bucket and table env vars", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: Match.objectLike({
        BOOKS_BUCKET: Match.anyValue(), SITE_BUCKET: Match.anyValue(), DOWNLOADS_TABLE: Match.anyValue(),
      }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith(["s3:GetObject*"]) }),
        Match.objectLike({
          Action: "dynamodb:PutItem",
          Resource: Match.anyValue(),
        }),
      ]) }),
    });
  });

  it("exposes POST /download behind a Cognito JWT authorizer with CORS for the site and localhost", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({
        AllowOrigins: [`https://${CONFIG.siteDomain}`, CONFIG.localDevOrigin],
        AllowMethods: Match.arrayWith(["POST"]),
        AllowHeaders: Match.arrayWith(["authorization", "content-type"]),
      }),
    });
    t.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: Match.objectLike({ Audience: [Match.anyValue()] }),
    });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /download",
      AuthorizationType: "JWT",
    });
  });
});
