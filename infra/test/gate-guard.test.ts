import { describe, expect, it } from "vitest";
import { GATE_GUARD_CODE } from "../lib/gate-guard";

function handlerFor(code: string): (event: { request: { uri: string } }) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${code}; return handler;`)();
}

const handler = handlerFor(GATE_GUARD_CODE);

function invoke(uri: string) {
  return handler({ request: { uri } });
}

describe("GATE_GUARD_CODE", () => {
  it.each(["/index.html", "/assets/x.js", "/privacy", "/covers"])("passes %s through unchanged", (uri) => {
    const request = { uri };
    expect(handler({ request })).toBe(request);
  });

  it.each([
    "/catalog%2Ejson",
    "//catalog.json",
    "/./catalog.json",
    "/covers%2Fabc.webp",
    "/%2Fcovers/abc.webp",
  ])("blocks the encoded-path bypass %s with 403", (uri) => {
    expect(invoke(uri)).toEqual({ statusCode: 403, statusDescription: "Forbidden" });
  });

  it("blocks a malformed percent-encoding with 400", () => {
    expect(invoke("/%E0%A4%A")).toEqual({ statusCode: 400, statusDescription: "Bad Request" });
  });
});
