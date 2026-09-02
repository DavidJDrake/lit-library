import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";
import { Signing } from "../lib/signing";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

describe("Signing", () => {
  it("creates a CloudFront public key from the configured PEM and a key group containing it", () => {
    const stack = new Stack(new App(), "Test");
    new Signing(stack, "Signing", { config });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::CloudFront::PublicKey", {
      PublicKeyConfig: Match.objectLike({ EncodedKey: config.cloudfrontPublicKeyPem }),
    });
    t.hasResourceProperties("AWS::CloudFront::KeyGroup", {
      KeyGroupConfig: Match.objectLike({ Items: [Match.objectLike({ Ref: Match.stringLikeRegexp("^SigningPublicKey") })] }),
    });
  });
});
