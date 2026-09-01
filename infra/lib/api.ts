import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "node:path";
import { CONFIG } from "./config";

export interface ApiProps {
  userPool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
  booksBucket: s3.IBucket;
  siteBucket: s3.IBucket;
}

export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

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
      environment: {
        BOOKS_BUCKET: props.booksBucket.bucketName,
        SITE_BUCKET: props.siteBucket.bucketName,
        DOWNLOADS_TABLE: this.table.tableName,
      },
    });
    props.booksBucket.grantRead(downloadFn);
    props.siteBucket.grantRead(downloadFn, "catalog.json");
    this.table.grant(downloadFn, "dynamodb:PutItem");

    const authorizer = new HttpJwtAuthorizer("Jwt", `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${props.userPool.userPoolId}`, {
      jwtAudience: [props.client.userPoolClientId],
    });

    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [`https://${CONFIG.siteDomain}`, CONFIG.localDevOrigin],
        allowMethods: [apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });

    this.httpApi.addRoutes({
      path: "/download",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("DownloadIntegration", downloadFn),
    });
  }
}
