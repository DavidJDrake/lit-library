import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class Storage extends Construct {
  readonly booksBucket: s3.Bucket;
  readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.booksBucket = new s3.Bucket(this, "Books", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // The indexer already uploads with StorageClass=INTELLIGENT_TIERING;
          // this catches anything uploaded by other means.
          transitions: [
            { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) },
          ],
        },
      ],
    });

    this.siteBucket = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
