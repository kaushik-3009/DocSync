import { useEffect, useState, type FormEvent } from "react";
import { fetchPageRoles, grantPageRole, type PageRole } from "./api.js";
import type { AuthUser } from "./auth.js";

type InviteRole = "editor" | "viewer";

/**
 * A deliberately small roster and invite panel. Role enforcement stays at the
 * server boundary; this only reflects the current user's role so the UI does
 * not imply that a viewer or editor can manage access.
 */
export function SharePanel({
  pageId,
  currentUser,
  activeUserIds,
  onClose,
}: {
  pageId: string;
  currentUser: AuthUser | null;
  /** Stable user IDs currently publishing awareness for this page. */
  activeUserIds: string[];
  onClose: () => void;
}) {
  const [roles, setRoles] = useState<PageRole[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("editor");
  const [inviteState, setInviteState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);

  async function loadRoles() {
    setRoles(null);
    setLoadError(null);
    try {
      const response = await fetchPageRoles(pageId);
      setRoles(response.roles);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load collaborators.");
    }
  }

  useEffect(() => {
    void loadRoles();
    setEmail("");
    setInviteRole("editor");
    setInviteState("idle");
    setInviteMessage(null);
    // This component is replaced on close; Escape is provided for the common
    // modal interaction without making the toolbar itself keyboard-modal.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Resets the panel per page; loadRoles is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, onClose]);

  const currentRole = roles?.find((entry) => entry.userId === currentUser?.id)?.role;
  const isOwner = currentRole === "owner";
  const inviteDisabled = !isOwner || inviteState === "submitting";

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteDisabled) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setInviteState("error");
      setInviteMessage("Enter a registered collaborator's email address.");
      return;
    }

    setInviteState("submitting");
    setInviteMessage(null);
    try {
      await grantPageRole(pageId, normalizedEmail, inviteRole);
      setInviteState("success");
      // The API intentionally does not disclose whether an email has an
      // account. Preserve that privacy guarantee in the message shown here.
      setInviteMessage("Invitation sent. Access begins only after the recipient accepts it.");
      setEmail("");
      await loadRoles();
    } catch (error) {
      setInviteState("error");
      setInviteMessage(error instanceof Error ? error.message : "Unable to update collaborator access.");
    }
  }

  return (
    <div className="share-panel-overlay" onMouseDown={onClose}>
      <section
        className="share-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="share-panel-header">
          <div>
            <h3 id="share-panel-title">Collaborators</h3>
            <p>Documents stay private until a recipient accepts an invitation.</p>
          </div>
          <button type="button" aria-label="Close collaborators" className="share-panel-close" onClick={onClose}>×</button>
        </header>

        {loadError ? (
          <div className="share-panel-message" role="alert">
            Collaborators are unavailable right now — {loadError}
          </div>
        ) : roles === null ? (
          <div className="share-panel-message">Loading collaborators…</div>
        ) : (
          <>
            <ul className="collaborator-list" aria-label="Current collaborators">
              {roles.map((entry) => (
                <li key={entry.userId}>
                  <span className="collaborator-email">
                    {entry.email}{entry.userId === currentUser?.id ? " (you)" : ""}
                  </span>
                  <span className="collaborator-meta">
                    <span className="collaborator-role">{entry.role}</span>
                    <span
                      className={`collaborator-presence ${activeUserIds.includes(entry.userId) ? "is-active" : "is-inactive"}`}
                      aria-label={activeUserIds.includes(entry.userId) ? "On this page" : "Not on this page"}
                    >
                      <span className="collaborator-presence-dot" aria-hidden="true" />
                      {activeUserIds.includes(entry.userId) ? "On this page" : "Not on this page"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <form className="share-invite-form" onSubmit={submitInvite}>
              <div className="share-invite-heading">
                <label htmlFor="collaborator-email">Invite collaborator</label>
                {!isOwner && <span className="share-forbidden">Only the page owner can invite people.</span>}
              </div>
              <div className="share-invite-controls">
                <input
                  id="collaborator-email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={inviteDisabled}
                />
                <select
                  aria-label="Collaborator role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as InviteRole)}
                  disabled={inviteDisabled}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button type="submit" className="share-invite-button" disabled={inviteDisabled}>
                  {inviteState === "submitting" ? "Inviting…" : "Invite"}
                </button>
              </div>
              {inviteMessage && (
                <p className={`share-invite-message ${inviteState === "error" ? "is-error" : ""}`} role={inviteState === "error" ? "alert" : "status"}>
                  {inviteMessage}
                </p>
              )}
            </form>
          </>
        )}
      </section>
    </div>
  );
}
