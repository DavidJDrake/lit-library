import { Duration } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "node:path";

export interface BackupProps {
  libraryTable: dynamodb.ITable;
  downloadsTable: dynamodb.ITable;
  backupBucket: s3.IBucket;
}

// Weekly export of the two tables PITR already protects continuously — a readable
// snapshot that survives PITR being turned off, and a second producer of the same
// file format scripts/backup.sh writes.
// See docs/superpowers/specs/2026-09-12-backup-resilience-design.md.
export class Backup extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: BackupProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Fn", {
      entry: path.join(__dirname, "../lambda/backup/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        LIBRARY_TABLE: props.libraryTable.tableName,
        DOWNLOADS_TABLE: props.downloadsTable.tableName,
        BACKUP_BUCKET: props.backupBucket.bucketName,
      },
    });

    props.libraryTable.grantReadData(this.fn);
    props.downloadsTable.grantReadData(this.fn);
    // Put only. A bug or a compromise here can add a backup, never remove one.
    props.backupBucket.grantPut(this.fn);

    new events.Rule(this, "Weekly", {
      description: "Export both DynamoDB tables to the backup bucket",
      schedule: events.Schedule.rate(Duration.days(7)),
      targets: [new targets.LambdaFunction(this.fn)],
    });
  }
}
