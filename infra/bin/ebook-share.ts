import { App } from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { EbookShareStack } from "../lib/ebook-share-stack";

const config = loadConfig();
const app = new App();
new EbookShareStack(app, "EbookShare", {
  config,
  env: { account: config.account, region: config.region },
});
