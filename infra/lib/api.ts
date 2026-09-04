import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";
import type { InfraConfig } from "./config";

export interface ApiProps {
  config: InfraConfig;
  userPool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
  booksBucket: s3.IBucket;
  siteBucket: s3.IBucket;
  keyPairId: string;
}

export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config } = props;

    this.table = new dynamodb.Table(this, "Downloads", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const downloadFn = new NodejsFunction(this, "DownloadFn", {
      entry: path.join(__dirname, "../lambda/download/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        BOOKS_BUCKET: props.booksBucket.bucketName,
        SITE_BUCKET: props.siteBucket.bucketName,
        DOWNLOADS_TABLE: this.table.tableName,
      },
    });
    // Read-only, object-scoped access only — no s3:List*/GetBucket* on the bucket.
    downloadFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [props.booksBucket.arnForObjects("*")],
    }));
    props.siteBucket.grantRead(downloadFn, "catalog.json");
    this.table.grant(downloadFn, "dynamodb:PutItem");

    const signingSecret = secretsmanager.Secret.fromSecretNameV2(this, "SigningSecret", config.signingKeySecretName);
    const sessionFn = new NodejsFunction(this, "SessionFn", {
      entry: path.join(__dirname, "../lambda/session/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SIGNING_KEY_SECRET_NAME: config.signingKeySecretName,
        SITE_DOMAIN: config.siteDomain,
        KEY_PAIR_ID: props.keyPairId,
      },
      // Only the Secrets Manager client is available in the Lambda runtime;
      // @aws-sdk/cloudfront-signer must be bundled into the asset.
      bundling: { externalModules: ["@aws-sdk/client-secrets-manager"] },
    });
    signingSecret.grantRead(sessionFn);

    const authorizer = new HttpUserPoolAuthorizer("Jwt", props.userPool, {
      userPoolClients: [props.client],
    });

    // All calls arrive same-origin through CloudFront's /api/* behavior — no CORS needed.
    this.httpApi = new apigw.HttpApi(this, "HttpApi", { defaultAuthorizer: authorizer });

    this.httpApi.addRoutes({
      path: "/api/download",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("DownloadIntegration", downloadFn),
    });
    const sessionIntegration = new HttpLambdaIntegration("SessionIntegration", sessionFn);
    this.httpApi.addRoutes({
      path: "/api/session",
      methods: [apigw.HttpMethod.GET],
      integration: sessionIntegration,
    });
    // Unauthenticated: it only clears cookies, so sign-out can still end the
    // CloudFront session even after the Cognito ID token is no longer valid.
    this.httpApi.addRoutes({
      path: "/api/session",
      methods: [apigw.HttpMethod.DELETE],
      integration: sessionIntegration,
      authorizer: new apigw.HttpNoneAuthorizer(),
    });
  }
}
