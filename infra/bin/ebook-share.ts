import { App } from "aws-cdk-lib";
import { CONFIG } from "../lib/config";
import { EbookShareStack } from "../lib/ebook-share-stack";

const app = new App();
new EbookShareStack(app, "EbookShare", {
  env: { account: CONFIG.account, region: CONFIG.region },
});
