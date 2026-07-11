import { useState, type FormEvent } from "react";
import { registerUser, loginUser } from "./api.js";
import { storeToken } from "./auth.js";

/**
 * Two shapes, one component: `mandatory` (server has JWT_SECRET configured —
 * every WS connection needs a valid token, so there's no usable guest mode)
 * renders as a full-page gate with no way to dismiss it; otherwise it renders
 * as a dismissible modal opened from the toolbar's "Sign in" button, with a
 * "Continue as guest" escape hatch back to the existing random-identity flow.
 */
export function LoginScreen({ mandatory, onClose }: { mandatory: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const { token } = mode === "signup" ? await registerUser(email, password) : await loginUser(email, password);
      storeToken(token);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const panel = (
    <div
      className="auth-panel"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={mode === "signin" ? "Sign in" : "Create account"}
    >
      <div className="auth-brand">Collab</div>
      <h1 className="auth-title">{mode === "signin" ? "Sign in" : "Create your account"}</h1>
      <p className="auth-subtitle">
        {mode === "signin"
          ? "Sign in to keep your name and presence consistent across tabs and devices."
          : "Just an email and password — takes a few seconds."}
      </p>

      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button
        type="button"
        className="auth-toggle"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
        }}
      >
        {mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
      </button>

      {!mandatory && (
        <button type="button" className="auth-guest" onClick={onClose}>
          Continue as guest
        </button>
      )}
    </div>
  );

  if (mandatory) {
    return <div className="auth-page">{panel}</div>;
  }
  return (
    <div className="auth-overlay" onClick={onClose}>
      {panel}
    </div>
  );
}
