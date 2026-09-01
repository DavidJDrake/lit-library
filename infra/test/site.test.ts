import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../lib/config";
import { Site } from "../lib/site";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const bucket = new s3.Bucket(stack, "SiteBucket");
  const site = new Site(stack, "Site", { siteBucket: bucket });
  return { t: Template.fromStack(stack), site };
}

describe("Site", () => {
  it("requests a DNS-validated certificate for the site domain", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: CONFIG.siteDomain,
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: CONFIG.siteDomain, HostedZoneId: CONFIG.hostedZoneId }],
    });
  });

  it("serves the bucket through CloudFront with OAC, HTTPS redirect, and SPA fallbacks", () => {
    const { t } = synth();
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [CONFIG.siteDomain],
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
  });

  it("creates A and AAAA alias records in the hosted zone", () => {
    const { t } = synth();
    t.resourceCountIs("AWS::Route53::RecordSet", 2);
    // Check A record
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "A",
      Name: `${CONFIG.siteDomain}.`,
      HostedZoneId: CONFIG.hostedZoneId,
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    });
    // Check AAAA record
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "AAAA",
      Name: `${CONFIG.siteDomain}.`,
      HostedZoneId: CONFIG.hostedZoneId,
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    });
  });

  it("exposes the https url", () => {
    const { site } = synth();
    expect(site.url).toBe(`https://${CONFIG.siteDomain}`);
  });
});
