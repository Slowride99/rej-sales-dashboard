import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./AuthGate";
import AccountsBoard from "./AccountsBoard";

// ?view=accounts opens the ad accounts screen; everything else is the existing app.
const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      {view === "accounts" ? <AccountsBoard /> : <App />}
    </AuthGate>
  </React.StrictMode>
);