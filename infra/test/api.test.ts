import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
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
        Match.objectLike({ Action: "s3:GetObject", Resource: Match.anyValue() }),
        Match.objectLike({
          Action: "dynamodb:PutItem",
          Resource: Match.anyValue(),
        }),
      ]) }),
    });
    // The statement scoped to the books bucket grants exactly s3:GetObject on
    // object ARNs only — no s3:List*/GetBucket* on that bucket.
    const json = t.toJSON();
    const booksBucketLogicalId = Object.keys(json.Resources).find(
      (id) => json.Resources[id].Type === "AWS::S3::Bucket" && id.startsWith("Books"),
    );
    expect(booksBucketLogicalId).toBeDefined();
    const policies = Object.values(json.Resources).filter((r: any) => r.Type === "AWS::IAM::Policy") as any[];
    const booksStatements = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => JSON.stringify(s.Resource).includes(booksBucketLogicalId as string));
    expect(booksStatements).toHaveLength(1);
    expect(booksStatements[0].Action).toBe("s3:GetObject");
  });

  it("sets a one-month log retention on the download function", () => {
    const t = synth();
    t.resourceCountIs("Custom::LogRetention", 1);
    t.hasResourceProperties("Custom::LogRetention", { RetentionInDays: 30 });
  });

  it("exposes POST /download behind a Cognito user-pool JWT authorizer with CORS for the site and localhost", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({
        AllowOrigins: [`https://${CONFIG.siteDomain}`, CONFIG.localDevOrigin],
        AllowMethods: Match.arrayWith(["POST"]),
        AllowHeaders: Match.arrayWith(["authorization", "content-type"]),
      }),
    });
    const json = t.toJSON();
    const authorizers = json.Resources
      ? Object.values(json.Resources).filter((r: any) => r.Type === "AWS::ApiGatewayV2::Authorizer")
      : [];
    expect(authorizers).toHaveLength(1);
    const authorizer = authorizers[0] as any;
    expect(authorizer.Properties.AuthorizerType).toBe("JWT");
    expect(authorizer.Properties.IdentitySource).toEqual(["$request.header.Authorization"]);
    // Audience must be a Ref to the actual UserPoolClient logical id (not anyValue()).
    const clientLogicalId = Object.keys(json.Resources).find(
      (id) => json.Resources[id].Type === "AWS::Cognito::UserPoolClient",
    );
    expect(clientLogicalId).toBeDefined();
    expect(authorizer.Properties.JwtConfiguration.Audience).toEqual([{ Ref: clientLogicalId }]);
    // Issuer is built from the pool id via Fn::Join, referencing the actual pool.
    const poolLogicalId = Object.keys(json.Resources).find(
      (id) => json.Resources[id].Type === "AWS::Cognito::UserPool",
    );
    expect(poolLogicalId).toBeDefined();
    const issuer = authorizer.Properties.JwtConfiguration.Issuer;
    expect(JSON.stringify(issuer)).toContain("cognito-idp.us-east-1.amazonaws.com/");
    expect(JSON.stringify(issuer)).toContain(poolLogicalId);

    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /download",
      AuthorizationType: "JWT",
    });
  });
});
