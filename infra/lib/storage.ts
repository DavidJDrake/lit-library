import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class Storage extends Construct {
  readonly booksBucket: s3.Bucket;
  readonly siteBucket: s3.Bucket;
  readonly backupBucket: s3.Bucket;

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

    // Backups live outside the bucket they protect: a bad sync or a recursive delete
    // in Books must not be able to take the backups with it.
    this.backupBucket = new s3.Bucket(this, "Backup", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [
        {
          // Small objects; keep a quarter of history and clean up failed uploads.
          noncurrentVersionExpiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      // No Intelligent-Tiering rule: these objects are mostly under the 128 KB
      // auto-tiering floor, so a transition would add reporting noise and no saving.
    });
  }
}
