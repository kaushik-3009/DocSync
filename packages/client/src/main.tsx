import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

// Public share links render a lightweight read-only view; loading the
// editor lazily keeps tldraw/CodeMirror out of that page's download.
const shareToken = new URLSearchParams(window.location.search).get("share");
const App = lazy(() => import("./App.js").then((module) => ({ default: module.App })));
const PublicPage = lazy(() => import("./PublicPage.js").then((module) => ({ default: module.PublicPage })));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}>{shareToken ? <PublicPage token={shareToken} /> : <App />}</Suspense>
  </React.StrictMode>
);
