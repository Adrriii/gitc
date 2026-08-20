import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applySavedTheme } from "./theme";
import "./styles/global.scss";

// Before the first render, or the window flashes the default palette on every
// start - most visible going from a light theme back into the app.
applySavedTheme();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
