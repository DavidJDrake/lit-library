import { Duration } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { InfraConfig } from "./config";

export interface AlertsProps {
  config: InfraConfig;
  functions: lambda.IFunction[];
  httpApi: apigw.HttpApi;
}

export const BILLING_THRESHOLD_USD = 5;
const WINDOW = Duration.minutes(5);

// Email alarms for the two things that matter on a site this size: something is
// erroring, or the bill is drifting. Two one-time manual steps after deploy — confirm
// the SNS subscription email and enable "Receive Billing Alerts" in the account's
// Billing preferences (the AWS/Billing metric is only published after that, and only
// in us-east-1) — are documented in infra/README.md.
export class Alerts extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertsProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, "Topic", { displayName: "Lit Library alerts" });
    this.topic.addSubscription(new EmailSubscription(props.config.alarmEmail));
    const notify = new SnsAction(this.topic);

    const wire = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify); // the "recovered" email is as useful as the alarm
    };

    for (const fn of props.functions) {
      // Ids like "Fn" repeat across constructs; qualify with the parent path so they stay unique.
      const alarmId = `${fn.node.path.split("/").slice(-2).join("")}Errors`;
      wire(new cloudwatch.Alarm(this, alarmId, {
        alarmDescription: `${fn.functionName} reported errors`,
        metric: fn.metricErrors({ period: WINDOW, statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // a quiet site is not a broken site
      }));
    }

    // Catches failures that never reach a Lambda (bundling, permissions, integration errors).
    wire(new cloudwatch.Alarm(this, "Api5xx", {
      alarmDescription: "HTTP API returned 5xx responses",
      metric: props.httpApi.metricServerError({ period: WINDOW, statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // Month-to-date estimated charges across the whole account, refreshed every few hours.
    wire(new cloudwatch.Alarm(this, "EstimatedCharges", {
      alarmDescription: `Estimated month-to-date AWS charges exceed $${BILLING_THRESHOLD_USD}`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/Billing",
        metricName: "EstimatedCharges",
        dimensionsMap: { Currency: "USD" },
        statistic: "Maximum",
        period: Duration.hours(6),
      }),
      threshold: BILLING_THRESHOLD_USD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // absent until billing alerts are enabled
    }));
  }
}
