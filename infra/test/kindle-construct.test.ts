import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";
import { Kindle } from "../lib/kindle";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  new Kindle(stack, "Kindle", {
    config, httpApi: new apigw.HttpApi(stack, "HttpApi"), userPool: new cognito.UserPool(stack, "Pool"),
    booksBucket: new s3.Bucket(stack, "Books"), siteBucket: new s3.Bucket(stack, "Site"),
    libraryTable: table("Lib"), downloadsTable: new dynamodb.Table(stack, "Dl", { partitionKey: { name: "email", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING } }),
    notificationsTable: table("Notif"), alertsTopic: new sns.Topic(stack, "Alerts"),
  });
  return Template.fromStack(stack);
}

describe("Kindle", () => {
  it("verifies the site domain with Easy DKIM records in Route 53", () => {
    const t = synth();
    t.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "lit.example.com", DkimAttributes: { SigningEnabled: true } });
    t.resourceCountIs("AWS::Route53::RecordSet", 3);
    t.hasResourceProperties("AWS::Route53::RecordSet", { Type: "CNAME", HostedZoneId: "Z0123456789EXAMPLE00" });
    // Each record's Name/ResourceRecords must be the identity's DkimDNSTokenName/ValueN
    // attributes verbatim (an Fn::GetAtt), not wrapped in an Fn::Join with the zone name
    // appended a second time — that double-suffix bug is why this is asserted explicitly.
    for (let n = 1; n <= 3; n++) {
      t.hasResourceProperties("AWS::Route53::RecordSet", Match.objectLike({
        Name: { "Fn::GetAtt": [Match.stringLikeRegexp("^KindleIdentity"), `DkimDNSTokenName${n}`] },
        ResourceRecords: [{ "Fn::GetAtt": [Match.stringLikeRegexp("^KindleIdentity"), `DkimDNSTokenValue${n}`] }],
      }));
    }
  });
  it("routes bounce, complaint, and reject events to an SNS topic that triggers the events Lambda", () => {
    const t = synth();
    // aws-cdk-lib's EmailSendingEvent enum maps to lowercase SES API values, not the
    // uppercase names of the enum members themselves — verified against the installed typings.
    t.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({ Enabled: true, MatchingEventTypes: ["bounce", "complaint", "reject"], SnsDestination: Match.anyValue() }),
    });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });
  });
  it("gives the kindle Lambda only what it needs", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60, MemorySize: 1024,
      Environment: { Variables: Match.objectLike({
        KINDLE_SENDER: "library@lit.example.com", KINDLE_CONFIG_SET: Match.anyValue(), BOOKS_BUCKET: Match.anyValue(), SITE_BUCKET: Match.anyValue(),
        LIBRARY_TABLE: Match.anyValue(), DOWNLOADS_TABLE: Match.anyValue(),
      }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: ["ses:SendEmail", "ses:SendRawEmail"], Resource: Match.arrayWith([Match.objectLike({ "Fn::Join": Match.anyValue() })]) }),
    ]) } });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: "s3:GetObject", Resource: Match.objectLike({ "Fn::Join": ["", [Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("^Books"), "Arn"] }), "/*"]] }) }),
    ]) } });
    // This CDK version (2.267) still implements logRetention via the Custom::LogRetention
    // provider rather than an AWS::Logs::LogGroup resource — verified via t.toJSON().
    t.hasResourceProperties("Custom::LogRetention", { RetentionInDays: 90 });
    for (const key of ["GET /api/kindle/address", "PUT /api/kindle/address", "POST /api/kindle/send"]) {
      t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: key });
    }
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
  });
  it("gives the events Lambda notification write, Cognito list, and alerts publish", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 30,
      Environment: { Variables: Match.objectLike({ NOTIFICATIONS_TABLE: Match.anyValue(), USER_POOL_ID: Match.anyValue(), ALERTS_TOPIC_ARN: Match.anyValue() }) },
    });
    t.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"] }),
      Match.objectLike({ Action: "sns:Publish", Resource: Match.objectLike({ Ref: Match.stringLikeRegexp("^Alerts") }) }),
    ]) } });
  });
});
