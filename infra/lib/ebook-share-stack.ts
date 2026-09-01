import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Api } from "./api";
import { Auth } from "./auth";
import { Site } from "./site";
import { Storage } from "./storage";

export class EbookShareStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const storage = new Storage(this, "Storage");
    const site = new Site(this, "Site", { siteBucket: storage.siteBucket });
    const auth = new Auth(this, "Auth");
    const api = new Api(this, "Api", {
      userPool: auth.userPool,
      client: auth.client,
      booksBucket: storage.booksBucket,
      siteBucket: storage.siteBucket,
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
  }
}
