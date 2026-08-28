import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SessionGate from "./auth/SessionGate";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SessionGate>
      <App />
    </SessionGate>
  </React.StrictMode>,
);
