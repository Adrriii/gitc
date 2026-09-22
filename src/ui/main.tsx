import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applySavedTheme } from "./theme";
import { installCrashReporter, reportWindowError } from "./crashReporter";
import "./styles/global.scss";

// Before the first render, or the window flashes the default palette on every
// start - most visible going from a light theme back into the app.
applySavedTheme();
installCrashReporter();

const el = document.getElementById("root");
if (el) {
  createRoot(el, {
    // A render that threw unmounts the whole tree, which is the blank window.
    // Providing this replaces React's own console report, so it is kept.
    onUncaughtError: (error, info) => {
      console.error(error);
      reportWindowError(error, "render" + (info.componentStack ?? ""));
    },
  }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
