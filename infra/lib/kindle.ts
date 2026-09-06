import { Duration, Stack } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SnsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import * as path from "node:path";
import type { InfraConfig } from "./config";
import { COGNITO_LIST_ACTIONS } from "./notifications";

export interface KindleProps {
  config: InfraConfig;
  httpApi: apigw.HttpApi;
  userPool: cognito.IUserPool;
  booksBucket: s3.IBucket;
  siteBucket: s3.IBucket;
  libraryTable: dynamodb.ITable;
  downloadsTable: dynamodb.ITable;
  notificationsTable: dynamodb.ITable;
  alertsTopic: sns.ITopic;
}

// Send-to-Kindle: SES identity for the site domain, a configuration set whose
// bounce/complaint/reject events reach the kindle-events Lambda, and the kindle
// Lambda that builds and sends the email. See docs/superpowers/specs/2026-09-05-send-to-kindle-design.md.
export class Kindle extends Construct {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly eventsTopic: sns.Topic;
  readonly fn: NodejsFunction;
  readonly eventsFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: KindleProps) {
    super(scope, id);
    const { config } = props;
    const external = ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-s3"]; // runtime-provided; bundle the rest

    // The sender's domain is the site domain (loadConfig enforces it); verify it with Easy DKIM.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: config.hostedZoneId, zoneName: config.hostedZoneName });
    // dkimSigning defaults to true at the SES API level, but CDK only emits DkimAttributes
    // when a value is given, so state it explicitly.
    this.identity = new ses.EmailIdentity(this, "Identity", { identity: ses.Identity.domain(config.siteDomain), dkimSigning: true });
    this.identity.dkimRecords.forEach((r, i) => {
      new route53.CnameRecord(this, `Dkim${i}`, { zone, recordName: r.name, domainName: r.value, ttl: Duration.hours(1) });
    });

    this.eventsTopic = new sns.Topic(this, "EventsTopic", { displayName: "Lit Library Kindle delivery events" });
    this.configurationSet = new ses.ConfigurationSet(this, "ConfigSet", {});
    this.configurationSet.addEventDestination("Events", {
      destination: ses.EventDestination.snsTopic(this.eventsTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT],
    });

    // ConfigurationSet has no configurationSetArn; build it the way SES ARNs are documented.
    const configurationSetArn = Stack.of(this).formatArn({
      service: "ses",
      resource: "configuration-set",
      resourceName: this.configurationSet.configurationSetName,
    });

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/kindle/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 1024, // a 28 MB file is base64-encoded in memory
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        KINDLE_SENDER: config.kindleSender,
        KINDLE_CONFIG_SET: this.configurationSet.configurationSetName,
        BOOKS_BUCKET: props.booksBucket.bucketName,
        SITE_BUCKET: props.siteBucket.bucketName,
        LIBRARY_TABLE: props.libraryTable.tableName,
        DOWNLOADS_TABLE: props.downloadsTable.tableName,
      },
      bundling: { externalModules: external },
    });
    this.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.booksBucket.arnForObjects("*")] }));
    props.siteBucket.grantRead(this.fn, "catalog.json");
    props.libraryTable.grantReadWriteData(this.fn);
    props.downloadsTable.grant(this.fn, "dynamodb:PutItem");
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      resources: [this.identity.emailIdentityArn, configurationSetArn],
    }));

    const integration = new HttpLambdaIntegration("KindleIntegration", this.fn);
    props.httpApi.addRoutes({ path: "/api/kindle/address", methods: [apigw.HttpMethod.GET, apigw.HttpMethod.PUT], integration });
    props.httpApi.addRoutes({ path: "/api/kindle/send", methods: [apigw.HttpMethod.POST], integration });

    this.eventsFn = new NodejsFunction(this, "EventsFn", {
      entry: path.join(__dirname, "../lambda/kindle-events/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        NOTIFICATIONS_TABLE: props.notificationsTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        ALERTS_TOPIC_ARN: props.alertsTopic.topicArn,
      },
      bundling: { externalModules: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"] },
    });
    this.eventsFn.addEventSource(new SnsEventSource(this.eventsTopic));
    props.notificationsTable.grantWriteData(this.eventsFn);
    this.eventsFn.addToRolePolicy(new iam.PolicyStatement({ actions: COGNITO_LIST_ACTIONS, resources: [props.userPool.userPoolArn] }));
    props.alertsTopic.grantPublish(this.eventsFn);
  }
}
