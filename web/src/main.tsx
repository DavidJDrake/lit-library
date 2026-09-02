import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import "./styles.css";

void (async () => {
  try {
    const { CONFIG } = await import("./config");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <AuthProvider config={CONFIG}>
          <App />
        </AuthProvider>
      </React.StrictMode>,
    );
  } catch (e) {
    document.getElementById("root")!.textContent = "Site misconfigured: " + (e as Error).message;
  }
})();
