import { generateKeyPairSync } from "node:crypto";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
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

  it("derives the public key name from a hash of the PEM so rotation creates a new resource", () => {
    const stack = new Stack(new App(), "Test");
    new Signing(stack, "Signing", { config });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::CloudFront::PublicKey", {
      PublicKeyConfig: Match.objectLike({ Name: Match.stringLikeRegexp("^EbookShareSigning-[0-9a-f]{16}$") }),
    });
  });

  it("changes the public key name when the PEM changes", () => {
    const otherPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();

    const stack1 = new Stack(new App(), "Test1");
    new Signing(stack1, "Signing", { config });
    const name1 = (Object.values(Template.fromStack(stack1).findResources("AWS::CloudFront::PublicKey"))[0] as {
      Properties: { PublicKeyConfig: { Name: string } };
    }).Properties.PublicKeyConfig.Name;

    const stack2 = new Stack(new App(), "Test2");
    new Signing(stack2, "Signing", { config: { ...config, cloudfrontPublicKeyPem: otherPem } });
    const name2 = (Object.values(Template.fromStack(stack2).findResources("AWS::CloudFront::PublicKey"))[0] as {
      Properties: { PublicKeyConfig: { Name: string } };
    }).Properties.PublicKeyConfig.Name;

    expect(name1).not.toBe(name2);
  });
});
