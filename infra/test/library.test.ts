import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { SEED_CATEGORIES } from "../lambda/library/constants";
import { Library } from "../lib/library";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const httpApi = new apigw.HttpApi(stack, "HttpApi");
  const userPool = new cognito.UserPool(stack, "Pool");
  const notificationsTable = new dynamodb.Table(stack, "Notif", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const library = new Library(stack, "Library", { httpApi, notificationsTable, userPool });
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

  it("wires one Lambda with read/write on the library table only and the six routes", () => {
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
      "GET /api/library", "PUT /api/books/{id}/category", "POST /api/suggestions", "POST /api/categories",
      "POST /api/suggestions/{id}/accept", "POST /api/suggestions/{id}/reject",
    ]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
    t.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
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
