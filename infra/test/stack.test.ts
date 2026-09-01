import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EbookShareStack } from "../lib/ebook-share-stack";

export function synthStack() {
  const app = new App();
  const stack = new EbookShareStack(app, "Test", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("EbookShareStack", () => {
  it("synthesizes a template", () => {
    const template = synthStack();
    expect(template.toJSON()).toHaveProperty("Resources");
  });
});
