import { CfnOutput, Fn, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Alerts } from "./alerts";
import { Api } from "./api";
import { Auth } from "./auth";
import type { InfraConfig } from "./config";
import { Kindle } from "./kindle";
import { Library } from "./library";
import { Notifications } from "./notifications";
import { Signing } from "./signing";
import { Site } from "./site";
import { Storage } from "./storage";

export interface EbookShareStackProps extends StackProps {
  config: InfraConfig;
}

export class EbookShareStack extends Stack {
  constructor(scope: Construct, id: string, props: EbookShareStackProps) {
    super(scope, id, props);
    const { config } = props;

    const storage = new Storage(this, "Storage");
    const signing = new Signing(this, "Signing", { config });
    const auth = new Auth(this, "Auth", { config });
    const api = new Api(this, "Api", {
      config,
      userPool: auth.userPool,
      client: auth.client,
      booksBucket: storage.booksBucket,
      siteBucket: storage.siteBucket,
      keyPairId: signing.publicKey.publicKeyId,
    });
    const notifications = new Notifications(this, "Notifications", { httpApi: api.httpApi, userPool: auth.userPool });
    const library = new Library(this, "Library", {
      httpApi: api.httpApi, notificationsTable: notifications.table, userPool: auth.userPool, downloadsTable: api.table,
    });
    library.table.grantReadData(notifications.fn);
    notifications.fn.addEnvironment("LIBRARY_TABLE", library.table.tableName);
    // Read-only: the OPDS feed and acquisition routes only ever resolve a token to a
    // reader (a GetItem by its hash). Generating, regenerating, and revoking a token is
    // the library Lambda's job, which already has read/write access to this table.
    library.table.grantReadData(api.downloadFn);
    api.downloadFn.addEnvironment("LIBRARY_TABLE", library.table.tableName);
    const alerts = new Alerts(this, "Alerts", {
      config,
      functions: [auth.preSignUp, api.downloadFn, api.sessionFn, library.fn, notifications.fn],
      httpApi: api.httpApi,
    });
    const kindle = new Kindle(this, "Kindle", {
      config, httpApi: api.httpApi, userPool: auth.userPool,
      booksBucket: storage.booksBucket, siteBucket: storage.siteBucket,
      libraryTable: library.table, downloadsTable: api.table, notificationsTable: notifications.table,
      alertsTopic: alerts.topic,
    });
    alerts.watch(kindle.fn);
    alerts.watch(kindle.eventsFn);
    // apiEndpoint is "https://<id>.execute-api.<region>.amazonaws.com"; CloudFront needs the host only.
    const apiDomainName = Fn.select(2, Fn.split("/", api.httpApi.apiEndpoint));
    const site = new Site(this, "Site", {
      config, siteBucket: storage.siteBucket, keyGroup: signing.keyGroup, apiDomainName,
      booksBucketDomainName: storage.booksBucket.bucketRegionalDomainName,
    });

    new CfnOutput(this, "SiteUrl", { value: site.url });
    new CfnOutput(this, "SiteBucketName", { value: storage.siteBucket.bucketName });
    new CfnOutput(this, "BooksBucketName", { value: storage.booksBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: site.distribution.distributionId });
    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.client.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: auth.hostedUiBaseUrl });
    new CfnOutput(this, "ApiUrl", { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, "DownloadsTable", { value: api.table.tableName });
    new CfnOutput(this, "LibraryTable", { value: library.table.tableName });
    new CfnOutput(this, "SigningKeyPairId", { value: signing.publicKey.publicKeyId });
    new CfnOutput(this, "NotificationsFunctionName", { value: notifications.fn.functionName });
    new CfnOutput(this, "KindleSender", { value: config.kindleSender });
  }
}
