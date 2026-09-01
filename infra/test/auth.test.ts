import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { Auth } from "../lib/auth";
import { CONFIG } from "../lib/config";

function synth() {
  const stack = new Stack(new App(), "Test", { env: { account: "123456789012", region: "us-east-1" } });
  const auth = new Auth(stack, "Auth");
  return { t: Template.fromStack(stack), auth };
}

describe("Auth", () => {
  it("creates a retained user pool with the pre-signup trigger and email sign-in", () => {
    const { t } = synth();
    t.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        UsernameAttributes: ["email"],
        LambdaConfig: { PreSignUp: Match.anyValue() },
      }),
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Environment: { Variables: { ALLOWED_EMAILS_PARAM: CONFIG.allowedEmailsParam } },
    });
  });

  it("seeds the allowlist SSM parameter", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::SSM::Parameter", {
      Name: CONFIG.allowedEmailsParam,
      Type: "String",
      Value: CONFIG.seedAllowedEmail,
    });
  });

  it("configures Google as the only identity provider, from Secrets Manager", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Google",
      ProviderType: "Google",
      ProviderDetails: Match.objectLike({
        authorize_scopes: "openid email profile",
        client_id: Match.anyValue(),
        client_secret: Match.anyValue(),
      }),
      AttributeMapping: Match.objectLike({ email: "email" }),
    });
    // Both values must be CloudFormation dynamic references into the one secret —
    // never literals. The reference renders as a full ARN joined from tokens, so
    // assert on the rendered template text rather than an exact string.
    const rendered = JSON.stringify(t.toJSON());
    expect(rendered).toContain("{{resolve:secretsmanager:");
    expect(rendered).toContain(`secret:${CONFIG.googleOAuthSecretName}`);
    expect(rendered).toContain(":SecretString:client_id");
    expect(rendered).toContain(":SecretString:client_secret");
  });

  it("creates a public web client using the code grant with the site and localhost callbacks", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
      SupportedIdentityProviders: ["Google"],
      CallbackURLs: [`https://${CONFIG.siteDomain}/`, `${CONFIG.localDevOrigin}/`],
      LogoutURLs: [`https://${CONFIG.siteDomain}/`, `${CONFIG.localDevOrigin}/`],
    });
  });

  it("closes the native sign-up/SRP path at the client — only refresh-token auth remains", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
    });
  });

  it("uses the Lite feature plan", () => {
    const { t } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolTier: "LITE",
    });
  });

  it("sets a one-month log retention on the pre-signup function", () => {
    const { t } = synth();
    t.resourceCountIs("Custom::LogRetention", 1);
    t.hasResourceProperties("Custom::LogRetention", { RetentionInDays: 30 });
  });

  it("uses the fixed hosted-UI domain prefix", () => {
    const { t, auth } = synth();
    t.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: CONFIG.cognitoDomainPrefix });
    expect(auth.hostedUiBaseUrl).toBe(`https://${CONFIG.cognitoDomainPrefix}.auth.us-east-1.amazoncognito.com`);
  });
});
