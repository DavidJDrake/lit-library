import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const full = {
  VITE_COGNITO_DOMAIN: "https://x.auth.us-east-1.amazoncognito.com/",
  VITE_CLIENT_ID: "abc",
  VITE_API_URL: "https://api.example.com/",
  VITE_REDIRECT_URI: "http://localhost:5173/",
  VITE_KINDLE_SENDER: "library@lit.example.com",
};

describe("readConfig", () => {
  it("reads all four values and strips trailing slashes from domain and api url", () => {
    expect(readConfig(full)).toEqual({
      cognitoDomain: "https://x.auth.us-east-1.amazoncognito.com",
      clientId: "abc",
      apiUrl: "https://api.example.com",
      redirectUri: "http://localhost:5173/",
      kindleSender: "library@lit.example.com",
    });
  });
  it("names every missing key", () => {
    expect(() => readConfig({ VITE_CLIENT_ID: "abc" })).toThrow(
      "Missing VITE_COGNITO_DOMAIN, VITE_API_URL, VITE_REDIRECT_URI, VITE_KINDLE_SENDER",
    );
  });
  it("reads kindleSender", () => {
    expect(readConfig({ ...full, VITE_KINDLE_SENDER: "library@lit.example.com" }).kindleSender).toBe(
      "library@lit.example.com",
    );
  });
});
