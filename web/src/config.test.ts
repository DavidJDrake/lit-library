import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const full = {
  VITE_COGNITO_DOMAIN: "https://x.auth.us-east-1.amazoncognito.com/",
  VITE_CLIENT_ID: "abc",
  VITE_API_URL: "https://api.example.com/",
  VITE_REDIRECT_URI: "http://localhost:5173/",
};

describe("readConfig", () => {
  it("reads all four values and strips trailing slashes from domain and api url", () => {
    expect(readConfig(full)).toEqual({
      cognitoDomain: "https://x.auth.us-east-1.amazoncognito.com",
      clientId: "abc",
      apiUrl: "https://api.example.com",
      redirectUri: "http://localhost:5173/",
    });
  });
  it("names every missing key", () => {
    expect(() => readConfig({ VITE_CLIENT_ID: "abc" })).toThrow(
      "Missing VITE_COGNITO_DOMAIN, VITE_API_URL, VITE_REDIRECT_URI",
    );
  });
});
