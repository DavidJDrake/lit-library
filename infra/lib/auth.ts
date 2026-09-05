import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "node:path";
import { ADMIN_GROUP } from "../lambda/library/constants";
import type { InfraConfig } from "./config";

export interface AuthProps {
  config: InfraConfig;
}

export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  readonly hostedUiBaseUrl: string;
  readonly preSignUp: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { config } = props;

    // IMPORTANT: this parameter's resource properties (name, description, seed value)
    // must never change after first deploy. It is deliberately CDK-seeded so the
    // first sign-in has an allowlist to check, but ANY edit here makes CloudFormation
    // reset `Value` on the next deploy, silently evicting every account added since via
    // `aws ssm put-parameter --overwrite`. Add/remove accounts only through that CLI
    // command (see infra/README.md) — never by editing `stringValue` below.
    const allowedEmails = new ssm.StringParameter(this, "AllowedEmails", {
      parameterName: config.allowedEmailsParam,
      stringValue: config.seedAllowedEmail,
      description: "Comma-separated emails allowed to sign in to ebook-share (edit in place)",
    });

    const preSignUp = this.preSignUp = new NodejsFunction(this, "PreSignUp", {
      entry: path.join(__dirname, "../lambda/pre-signup/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { ALLOWED_EMAILS_PARAM: config.allowedEmailsParam },
    });
    allowedEmails.grantRead(preSignUp);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true, // federated users are created on first Google sign-in; the trigger gates them
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      lambdaTriggers: { preSignUp },
      removalPolicy: RemovalPolicy.RETAIN,
      featurePlan: cognito.FeaturePlan.LITE,
    });

    // Members may accept category suggestions and add categories directly
    // (see infra/lib/library.ts). Add people with scripts/make-admin.sh.
    new cognito.CfnUserPoolGroup(this, "Admins", {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: "May accept category suggestions and add categories",
    });

    const googleSecret = secretsmanager.Secret.fromSecretNameV2(this, "GoogleSecret", config.googleOAuthSecretName);
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

    const callbackUrls = [`https://${config.siteDomain}/`, `${config.localDevOrigin}/`];
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
      // Close the native SignUp/SRP path at the client too: only Google (hosted-UI
      // authorization code grant) plus refresh-token renewal are permitted. Without
      // this, the client still supports USER_SRP_AUTH/USER_PASSWORD_AUTH, which lets
      // anyone call cognito-idp sign-up/initiate-auth directly against this client id.
      authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
    });
    this.client.node.addDependency(google);

    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });
    this.hostedUiBaseUrl = `https://${config.cognitoDomainPrefix}.auth.${config.region}.amazoncognito.com`;
  }
}
