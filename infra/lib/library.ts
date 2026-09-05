import { RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { SEED_AT, SEED_CATEGORIES } from "../lambda/library/constants";

export interface LibraryProps {
  httpApi: apigw.HttpApi;
}

// Runtime-mutable overlay on the static catalog: categories, per-book category
// changes, and category suggestions. See docs/superpowers/specs/2026-09-04-user-categories-design.md.
export class Library extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LibraryProps) {
    super(scope, id);
    void props; // routes are added in a later task

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Seed the built-in categories so catalog.json values and the table agree from
    // the first deploy. Conditional puts make redeploys no-ops and never delete.
    SEED_CATEGORIES.forEach((name, i) => {
      const call: cr.AwsSdkCall = {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: this.table.tableName,
          Item: {
            pk: { S: "CATEGORY" }, sk: { S: name }, nameLower: { S: name.toLowerCase() },
            createdBy: { S: "seed" }, createdAt: { S: SEED_AT }, source: { S: "seed" },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        physicalResourceId: cr.PhysicalResourceId.of(`seed-category-${i}`),
        ignoreErrorCodesMatching: "ConditionalCheckFailedException",
      };
      new cr.AwsCustomResource(this, `Seed${i}`, {
        onCreate: call,
        onUpdate: call,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.table.tableArn] }),
        installLatestAwsSdk: false,
        logRetention: logs.RetentionDays.ONE_MONTH,
      });
    });
  }
}
