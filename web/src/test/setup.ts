(import.meta.env as Record<string, string>).VITE_COGNITO_DOMAIN ??= "https://test.auth.us-east-1.amazoncognito.com";
(import.meta.env as Record<string, string>).VITE_CLIENT_ID ??= "test-client";
(import.meta.env as Record<string, string>).VITE_API_URL ??= "https://api.test";
(import.meta.env as Record<string, string>).VITE_REDIRECT_URI ??= "http://localhost:5173/";
(import.meta.env as Record<string, string>).VITE_KINDLE_SENDER ??= "library@lit.example.com";

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom does not implement scrolling; without a stub, window.scrollTo() logs a
// "Not implemented" error on every call instead of just being a no-op.
window.scrollTo = () => {};

afterEach(() => {
  window.sessionStorage.clear();
});
