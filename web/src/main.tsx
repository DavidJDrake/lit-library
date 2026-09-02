import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { CONFIG } from "./config";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider config={CONFIG}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
