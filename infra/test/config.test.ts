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
  it("refuses a non-example config that still has the example public key", () => {
    const example = loadConfig(EXAMPLE_CONFIG_PATH);
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.local.json");
    writeFileSync(file, JSON.stringify(example));
    expect(() => loadConfig(file)).toThrow(
      /config.local.json still contains the EXAMPLE public key — run scripts\/make-signing-key.sh first/,
    );
  });
  it("still loads the example config from its own path", () => {
    expect(() => loadConfig(EXAMPLE_CONFIG_PATH)).not.toThrow();
  });
});
