import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { SEED_CATEGORIES } from "../lambda/library/constants";
import { Library } from "../lib/library";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const userPool = new cognito.UserPool(stack, "Pool");
  const client = userPool.addClient("Client");
  // Mirrors how the real stack wires the API: one HttpApi whose defaultAuthorizer is
  // the pool's JWT authorizer, shared by every construct that calls addRoutes on it.
  const httpApi = new apigw.HttpApi(stack, "HttpApi", {
    defaultAuthorizer: new HttpUserPoolAuthorizer("Jwt", userPool, { userPoolClients: [client] }),
  });
  const notificationsTable = new dynamodb.Table(stack, "Notif", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const downloadsTable = new dynamodb.Table(stack, "Downloads", {
    partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const library = new Library(stack, "Library", { httpApi, notificationsTable, userPool, downloadsTable });
  return { t: Template.fromStack(stack), library };
}

describe("Library", () => {
  it("creates a retained on-demand table keyed by pk/sk", () => {
    const { t } = synth();
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      }),
    });
  });

  it("seeds every built-in category with a conditional, idempotent PutItem", () => {
    const { t } = synth();
    t.resourceCountIs("Custom::AWS", SEED_CATEGORIES.length);
    // The SDK call is serialised as a JSON string joined with the table-name token
    // (Fn::Join), so assert on the rendered template text rather than the property shape.
    const rendered = JSON.stringify(t.toJSON());
    expect(rendered.split("attribute_not_exists(pk)").length - 1).toBe(SEED_CATEGORIES.length * 2); // Create + Update
    expect(rendered.split("ConditionalCheckFailedException").length - 1).toBe(SEED_CATEGORIES.length * 2);
    for (const name of SEED_CATEGORIES) expect(rendered).toContain(name);
    expect(SEED_CATEGORIES).toContain("Other/Lifestyle");
  });

  it("wires one Lambda with read/write on the library table only and the ten routes", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Timeout: 15,
      Environment: { Variables: { LIBRARY_TABLE: Match.anyValue() } },
    });
    // Exactly one policy grants dynamodb read/write, and it names the table (plus its index ARN pattern) only.
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]), // arrayWith is order-sensitive; this is grantReadWriteData's order
        Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^LibraryTable"), "Arn"] })]),
      })]) },
    });
    for (const key of [
      "GET /api/library", "PUT /api/books/{id}/category", "PUT /api/books/{id}/status", "POST /api/suggestions", "POST /api/categories",
      "POST /api/suggestions/{id}/accept", "POST /api/suggestions/{id}/reject",
      "GET /api/opds/token", "POST /api/opds/token", "DELETE /api/opds/token",
    ]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 10);
    t.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  });

  it("authenticates every library route with the pool's JWT authorizer, including all three OPDS token routes", () => {
    const { t } = synth();
    const authorizerIds = Object.keys(t.findResources("AWS::ApiGatewayV2::Authorizer", { Properties: { AuthorizerType: "JWT" } }));
    expect(authorizerIds).toHaveLength(1);
    const jwtAuthorizerRef = { Ref: authorizerIds[0] };

    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r as { Properties: { RouteKey: string; AuthorizerId?: unknown } }).Properties);
    expect(routes).toHaveLength(10);
    for (const r of routes) {
      expect(r.AuthorizerId).toEqual(jwtAuthorizerRef);
    }
  });

  it("may only read the downloads table, not write it", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem"]), // grantReadData's action order
        Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^Downloads"), "Arn"] })]),
      })]) },
    });
    const rendered = JSON.stringify(t.toJSON());
    // The downloads table's own logical id never appears alongside a write action anywhere
    // in the synthesized template — this Lambda has no write grant on it.
    const policies = t.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } })
        .Properties.PolicyDocument.Statement;
      for (const s of statements) {
        const resources = JSON.stringify(s.Resource);
        if (!resources.includes("Downloads")) continue;
        const actions = ([] as string[]).concat(s.Action);
        for (const a of actions) expect(a).not.toMatch(/PutItem|UpdateItem|DeleteItem/);
      }
    }
    expect(rendered).toContain("Downloads");
  });

  it("may write notifications and list Cognito users", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ LIBRARY_TABLE: Match.anyValue(), NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"],
      })]) },
    });
  });
});
