import type { InvitationNotification } from "./api.js";

export function InvitationToast({ notification, pending, onRespond }: {
  notification: InvitationNotification;
  pending: boolean;
  onRespond: (action: "accept" | "decline") => void;
}) {
  return (
    <div className="invitation-toast" role="status">
      <div>
        <strong>{notification.payload.inviterEmail}</strong> invited you to collaborate on <strong>{notification.payload.documentTitle}</strong> as {notification.payload.role}.
      </div>
      <div className="invitation-actions">
        <button type="button" onClick={() => onRespond("accept")} disabled={pending}>Accept</button>
        <button type="button" className="is-secondary" onClick={() => onRespond("decline")} disabled={pending}>Decline</button>
      </div>
    </div>
  );
}
