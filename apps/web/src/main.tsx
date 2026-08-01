import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SessionGate from "./auth/SessionGate";
import "./styles.css";

// Desktop's entrypoint (`src/main.tsx`) renders `<App />` alone. The one
// addition is the §4.1 gate wrapped around it: `App` and every view below it
// stay unaware that sessions, organizations or accounts exist, which is what
// keeps them copies rather than forks.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SessionGate>
      <App />
    </SessionGate>
  </React.StrictMode>,
);
