import { createHash } from "node:crypto";
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
    // Name is derived from the PEM's hash so rotating the key (a new PEM in
    // config.local.json) creates a brand-new CloudFront PublicKey resource
    // instead of an in-place update — CloudFront rejects in-place key
    // material changes on an existing PublicKey.
    const hash = createHash("sha256").update(props.config.cloudfrontPublicKeyPem).digest("hex").slice(0, 16);
    this.publicKey = new cloudfront.PublicKey(this, "PublicKey", {
      publicKeyName: `EbookShareSigning-${hash}`,
      encodedKey: props.config.cloudfrontPublicKeyPem,
      comment: "Session cookie signing key for gated catalog/covers",
    });
    this.keyGroup = new cloudfront.KeyGroup(this, "KeyGroup", { items: [this.publicKey] });
  }
}
