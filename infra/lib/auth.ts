import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "node:path";
import { CONFIG } from "./config";

export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  readonly hostedUiBaseUrl: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const allowedEmails = new ssm.StringParameter(this, "AllowedEmails", {
      parameterName: CONFIG.allowedEmailsParam,
      stringValue: CONFIG.seedAllowedEmail,
      description: "Comma-separated emails allowed to sign in to ebook-share (edit in place)",
    });

    const preSignUp = new NodejsFunction(this, "PreSignUp", {
      entry: path.join(__dirname, "../lambda/pre-signup/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      environment: { ALLOWED_EMAILS_PARAM: CONFIG.allowedEmailsParam },
    });
    allowedEmails.grantRead(preSignUp);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true, // federated users are created on first Google sign-in; the trigger gates them
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      lambdaTriggers: { preSignUp },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const googleSecret = secretsmanager.Secret.fromSecretNameV2(this, "GoogleSecret", CONFIG.googleOAuthSecretName);
    const google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool: this.userPool,
      clientId: googleSecret.secretValueFromJson("client_id").unsafeUnwrap(), // resolves to a CFN dynamic reference, not a literal
      clientSecretValue: googleSecret.secretValueFromJson("client_secret"),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
      },
    });

    const callbackUrls = [`https://${CONFIG.siteDomain}/`, `${CONFIG.localDevOrigin}/`];
    this.client = this.userPool.addClient("Web", {
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      preventUserExistenceErrors: true,
    });
    this.client.node.addDependency(google);

    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: CONFIG.cognitoDomainPrefix },
    });
    this.hostedUiBaseUrl = `https://${CONFIG.cognitoDomainPrefix}.auth.${CONFIG.region}.amazoncognito.com`;
  }
}
