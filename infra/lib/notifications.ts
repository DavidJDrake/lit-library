import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";

export interface NotificationsProps {
  httpApi: apigw.HttpApi;
  userPool: cognito.IUserPool;
}

export const COGNITO_LIST_ACTIONS = ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup"];

// Per-recipient notification inbox. See docs/superpowers/specs/2026-09-05-notifications-design.md.
// The table is disposable (90-day TTL, not retained, not backed up).
export class Notifications extends Construct {
  readonly table: dynamodb.Table;
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationsProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/notifications/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { NOTIFICATIONS_TABLE: this.table.tableName, USER_POOL_ID: props.userPool.userPoolId },
    });
    this.table.grantReadWriteData(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));

    const integration = new HttpLambdaIntegration("NotificationsIntegration", this.fn);
    props.httpApi.addRoutes({ path: "/api/notifications", methods: [apigw.HttpMethod.GET], integration });
    props.httpApi.addRoutes({ path: "/api/notifications/read", methods: [apigw.HttpMethod.POST], integration });

    new CfnOutput(this, "FunctionName", { value: this.fn.functionName });
  }
}
