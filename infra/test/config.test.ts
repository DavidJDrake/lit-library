import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "../lib/config";

describe("loadConfig", () => {
  it("loads the example config", () => {
    const c = loadConfig(EXAMPLE_CONFIG_PATH);
    expect(c.siteDomain).toBe("lit.example.com");
    expect(c.cloudfrontPublicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });
  it("names every missing key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ account: "1", region: "us-east-1" }));
    expect(() => loadConfig(file)).toThrow(/Missing config keys: siteDomain, hostedZoneName/);
  });
  it("explains a missing file", () => {
    expect(() => loadConfig("/nonexistent/config.local.json")).toThrow(/copy config.example.json to config.local.json/);
  });
});
