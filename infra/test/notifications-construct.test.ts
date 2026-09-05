import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { describe, it } from "vitest";
import { Notifications } from "../lib/notifications";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const httpApi = new apigw.HttpApi(stack, "HttpApi");
  const userPool = new cognito.UserPool(stack, "Pool");
  new Notifications(stack, "Notifications", { httpApi, userPool });
  return Template.fromStack(stack);
}

describe("Notifications", () => {
  it("creates a disposable on-demand table with a TTL on expiresAt", () => {
    const t = synth();
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    });
  });
  it("wires the Lambda with table read/write, Cognito list permissions on the pool, and two routes", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"],
        Resource: Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^Pool"), "Arn"] }),
      })]) },
    });
    for (const key of ["GET /api/notifications", "POST /api/notifications/read"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
    t.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
  });
});
