import { Duration } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { InfraConfig } from "./config";
import { GATE_GUARD_CODE } from "./gate-guard";

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

    // Everything the SPA needs is same-origin: the API is proxied at /api/*, covers and the
    // catalog come from this distribution. The one exception is the Cognito hosted UI, which
    // the token exchange calls directly, so it is the only entry in connect-src. Built from
    // config rather than hardcoded, so no real host lands in the repository.
    const cognitoOrigin = `https://${config.cognitoDomainPrefix}.auth.${config.region}.amazoncognito.com`;
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      // Vite emits a stylesheet, but React and the app set inline style attributes at runtime,
      // which 'unsafe-inline' covers; it does not permit inline <script>, which is the risk
      // this policy exists to close.
      "style-src 'self' 'unsafe-inline'",
      // The favicon in index.html is an inline data: SVG.
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${cognitoOrigin}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "Security headers for the library site",
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        // Two years, matching the preload-list requirement, though the site is not submitted.
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    // Signed-cookie gate for the catalog and covers. Everything else stays public.
    const gated: cloudfront.BehaviorOptions = {
      origin: siteOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [props.keyGroup],
      responseHeadersPolicy,
    };

    // Same-origin API: nothing is cached, Authorization is forwarded.
    const apiCachePolicy = new cloudfront.CachePolicy(this, "ApiCachePolicy", {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1), // CloudFront rejects a header allowlist when max TTL is 0 ("caching disabled"); 1 s with default 0 is effectively uncached
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
      responseHeadersPolicy,
    };

    // CloudFront matches path patterns against the raw URI while S3 decodes
    // it, so an encoded/mangled path (e.g. /catalog%2Ejson, //catalog.json)
    // can dodge the gated behaviors below yet still resolve to a gated
    // object through this default behavior. Block those on the default
    // behavior only — the gated behaviors below match legitimate requests
    // first and must stay reachable without this function.
    const gateGuard = new cloudfront.Function(this, "GateGuard", {
      code: cloudfront.FunctionCode.fromInline(GATE_GUARD_CODE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: [config.siteDomain],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: gateGuard, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        responseHeadersPolicy,
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
