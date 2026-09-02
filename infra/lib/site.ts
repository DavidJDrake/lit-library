import { Duration } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { InfraConfig } from "./config";

export interface SiteProps {
  config: InfraConfig;
  siteBucket: s3.IBucket;
  keyGroup: cloudfront.IKeyGroup;
  apiDomainName: string;
}

export class Site extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly url: string;

  constructor(scope: Construct, id: string, props: SiteProps) {
    super(scope, id);
    const { config } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.siteDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(props.siteBucket);

    // Signed-cookie gate for the catalog and covers. Everything else stays public.
    const gated: cloudfront.BehaviorOptions = {
      origin: siteOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [props.keyGroup],
    };

    // Same-origin API: nothing is cached, Authorization is forwarded.
    const apiCachePolicy = new cloudfront.CachePolicy(this, "ApiCachePolicy", {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList("Authorization"),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    const api: cloudfront.BehaviorOptions = {
      origin: new origins.HttpOrigin(props.apiDomainName),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: apiCachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: [config.siteDomain],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/catalog.json": gated,
        "/covers/*": gated,
        "/api/*": api,
      },
      // SPA routing: unknown paths (and S3's 403 for missing keys) serve index.html
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
      ],
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
    new route53.ARecord(this, "ARecord", { zone, recordName: config.siteDomain, target });
    new route53.AaaaRecord(this, "AaaaRecord", { zone, recordName: config.siteDomain, target });

    this.url = `https://${config.siteDomain}`;
  }
}
