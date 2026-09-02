import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";
import { Signing } from "../lib/signing";
import { Site } from "../lib/site";

const config = loadConfig(EXAMPLE_CONFIG_PATH);

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const bucket = new s3.Bucket(stack, "SiteBucket");
  const signing = new Signing(stack, "Signing", { config });
  const site = new Site(stack, "Site", {
    config, siteBucket: bucket, keyGroup: signing.keyGroup,
    apiDomainName: "abc123.execute-api.us-east-1.amazonaws.com",
  });
  return { t: Template.fromStack(stack), site };
}

describe("Site", () => {
  it("requests a DNS-validated certificate for the site domain", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: config.siteDomain,
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: config.siteDomain, HostedZoneId: config.hostedZoneId }],
    });
  });

  it("serves the bucket through CloudFront with OAC, HTTPS redirect, and SPA fallbacks", () => {
    const { t } = synth();
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [config.siteDomain],
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
  });

  it("requires the signing key group for /catalog.json and /covers/*", () => {
    const { t } = synth();
    for (const pattern of ["/catalog.json", "/covers/*"]) {
      t.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: pattern,
              TrustedKeyGroups: [{ Ref: Match.stringLikeRegexp("^SigningKeyGroup") }],
              ViewerProtocolPolicy: "redirect-to-https",
            }),
          ]),
        }),
      });
    }
    // The default behavior must NOT require a key group (index.html/assets stay public).
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0] as { Properties: { DistributionConfig: { DefaultCacheBehavior: Record<string, unknown> } } };
    expect(dist.Properties.DistributionConfig.DefaultCacheBehavior.TrustedKeyGroups).toBeUndefined();
  });

  it("proxies /api/* to the HTTP API with a zero-TTL cache policy that forwards Authorization", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        MinTTL: 0, DefaultTTL: 0, MaxTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["Authorization"] },
          QueryStringsConfig: { QueryStringBehavior: "all" },
          CookiesConfig: { CookieBehavior: "none" },
        }),
      }),
    });
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([Match.objectLike({ DomainName: "abc123.execute-api.us-east-1.amazonaws.com" })]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/api/*",
            AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
            ViewerProtocolPolicy: "https-only",
            OriginRequestPolicyId: Match.anyValue(),
          }),
        ]),
      }),
    });
  });

  it("creates A and AAAA alias records in the hosted zone", () => {
    const { t } = synth();
    t.resourceCountIs("AWS::Route53::RecordSet", 2);
    const cloudFrontAliasTarget = Match.objectLike({
      DNSName: { "Fn::GetAtt": [Match.stringLikeRegexp("^SiteDistribution"), "DomainName"] },
      HostedZoneId: Match.objectLike({ "Fn::FindInMap": Match.anyValue() }),
    });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Type: "A", Name: `${config.siteDomain}.`, HostedZoneId: config.hostedZoneId, AliasTarget: cloudFrontAliasTarget });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Type: "AAAA", Name: `${config.siteDomain}.`, HostedZoneId: config.hostedZoneId, AliasTarget: cloudFrontAliasTarget });
  });

  it("exposes the https url", () => {
    const { site } = synth();
    expect(site.url).toBe(`https://${config.siteDomain}`);
  });
});
