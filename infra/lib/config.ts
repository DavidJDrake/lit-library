export const CONFIG = {
  account: "123456789012",
  region: "us-east-1",
  siteDomain: "lit.example.com",
  hostedZoneName: "example.com",
  hostedZoneId: "Z0123456789EXAMPLE00",
  cognitoDomainPrefix: "lit-example",
  googleOAuthSecretName: "ebook-share/google-oauth",
  allowedEmailsParam: "/ebook-share/allowed-emails",
  seedAllowedEmail: "owner@example.com",
  localDevOrigin: "http://localhost:5173",
} as const;
