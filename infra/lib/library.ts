import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "node:path";
import { SEED_AT, SEED_CATEGORIES } from "../lambda/library/constants";
import { COGNITO_LIST_ACTIONS } from "./notifications";

export interface LibraryProps {
  httpApi: apigw.HttpApi;
  notificationsTable: dynamodb.ITable;
  userPool: cognito.IUserPool;
}

// Runtime-mutable overlay on the static catalog: categories, per-book category
// changes, and category suggestions. See docs/superpowers/specs/2026-09-04-user-categories-design.md.
export class Library extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LibraryProps) {
    super(scope, id);

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

    const fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/library/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        LIBRARY_TABLE: this.table.tableName,
        NOTIFICATIONS_TABLE: props.notificationsTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
      },
      // Bundle the Cognito client rather than trust the runtime-provided SDK version; the
      // DynamoDB clients are runtime-provided and already in use.
      bundling: { externalModules: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"] },
    });
    this.table.grantReadWriteData(fn);
    props.notificationsTable.grantWriteData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));

    // One integration, six routes; the API's default JWT authorizer applies to all of them.
    const integration = new HttpLambdaIntegration("LibraryIntegration", fn);
    const routes: Array<[string, apigw.HttpMethod]> = [
      ["/api/library", apigw.HttpMethod.GET],
      ["/api/books/{id}/category", apigw.HttpMethod.PUT],
      ["/api/suggestions", apigw.HttpMethod.POST],
      ["/api/categories", apigw.HttpMethod.POST],
      ["/api/suggestions/{id}/accept", apigw.HttpMethod.POST],
      ["/api/suggestions/{id}/reject", apigw.HttpMethod.POST],
    ];
    for (const [routePath, method] of routes) {
      props.httpApi.addRoutes({ path: routePath, methods: [method], integration });
    }
  }
}
