import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { Alerts, BILLING_THRESHOLD_USD } from "../lib/alerts";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const fn = (id: string) => new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=()=>{}"),
  });
  const httpApi = new apigw.HttpApi(stack, "HttpApi");
  new Alerts(stack, "Alerts", { config, functions: [fn("A"), fn("B")], httpApi });
  return Template.fromStack(stack);
}

describe("Alerts", () => {
  it("creates one topic with an email subscription from config", () => {
    const t = synth();
    t.resourceCountIs("AWS::SNS::Topic", 1);
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: config.alarmEmail });
  });

  it("alarms on any Lambda error, treating missing data as OK, and notifies on ALARM and OK", () => {
    const t = synth();
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm", {
      Properties: { Namespace: "AWS/Lambda", MetricName: "Errors" },
    }));
    expect(alarms).toHaveLength(2);
    for (const a of alarms) {
      expect(a.Properties).toMatchObject({
        Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      });
      expect(a.Properties.AlarmActions).toHaveLength(1);
      expect(a.Properties.OKActions).toHaveLength(1);
    }
  });

  it("alarms on API 5xx responses", () => {
    const t = synth();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", Match.objectLike({
      Namespace: "AWS/ApiGateway", MetricName: "5xx", Statistic: "Sum", Period: 300, Threshold: 1,
      TreatMissingData: "notBreaching",
    }));
  });

  it("alarms when estimated charges exceed the threshold (billing metric, USD, 6-hour period)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", Match.objectLike({
      Namespace: "AWS/Billing", MetricName: "EstimatedCharges", Statistic: "Maximum", Period: 21600,
      Threshold: BILLING_THRESHOLD_USD, ComparisonOperator: "GreaterThanThreshold",
      Dimensions: [{ Name: "Currency", Value: "USD" }],
    }));
    expect(BILLING_THRESHOLD_USD).toBe(5);
  });

  it("creates exactly one alarm per function plus the API and billing alarms", () => {
    synth().resourceCountIs("AWS::CloudWatch::Alarm", 4);
  });
});
