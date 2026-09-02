import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import type { InfraConfig } from "./config";

export interface SigningProps {
  config: InfraConfig;
}

/** CloudFront trusted key group used to validate signed cookies on gated paths. */
export class Signing extends Construct {
  readonly publicKey: cloudfront.PublicKey;
  readonly keyGroup: cloudfront.KeyGroup;

  constructor(scope: Construct, id: string, props: SigningProps) {
    super(scope, id);
    this.publicKey = new cloudfront.PublicKey(this, "PublicKey", {
      encodedKey: props.config.cloudfrontPublicKeyPem,
      comment: "Session cookie signing key for gated catalog/covers",
    });
    this.keyGroup = new cloudfront.KeyGroup(this, "KeyGroup", { items: [this.publicKey] });
  }
}
