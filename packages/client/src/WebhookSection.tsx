import { useEffect, useState, type FormEvent } from "react";
import { createWebhook, deleteWebhook, listWebhooks, pingWebhook, type WebhookSummary } from "./api.js";
import { formatRelativeTime } from "./relativeTime.js";

/** Owner-only webhook management. Deliveries are signed with a secret that
 *  is shown once, right after the webhook is created. */
export function WebhookSection({ pageId }: { pageId: string }) {
  const [webhooks, setWebhooks] = useState<WebhookSummary[] | null>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = () =>
    listWebhooks(pageId)
      .then((res) => setWebhooks(res.webhooks))
      .catch((err) => setMessage({ text: err instanceof Error ? err.message : String(err), error: true }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const created = await createWebhook(pageId, url.trim());
      setSecret(created.secret);
      setUrl("");
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  }

  async function act(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ text: success, error: false });
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  }

  return (
    <section className="public-links" aria-label="Webhooks">
      <form className="share-invite-form" onSubmit={add}>
        <div className="share-invite-heading">
          <label htmlFor="webhook-url">Webhooks</label>
        </div>
        <p className="public-links-hint">DocSync POSTs a signed page.updated event to these URLs a few seconds after edits.</p>
        <div className="share-invite-controls">
          <input
            id="webhook-url"
            type="url"
            placeholder="https://example.com/hooks/docsync"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="share-invite-button" disabled={!url.trim()}>
            Add
          </button>
        </div>
      </form>
      {secret && (
        <>
          <p className="public-links-hint">Save this signing secret now; it won't be shown again.</p>
          <div className="public-link-fresh">
            <input readOnly value={secret} aria-label="Webhook signing secret" onFocus={(event) => event.currentTarget.select()} />
          </div>
        </>
      )}
      {message && (
        <p className={`share-invite-message ${message.error ? "is-error" : ""}`} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      {webhooks && webhooks.length > 0 && (
        <ul className="public-link-list" aria-label="Registered webhooks">
          {webhooks.map((webhook) => (
            <li key={webhook.id}>
              <span className="webhook-url" title={webhook.url}>
                {webhook.url}
                <span className="public-links-hint">
                  {" "}
                  {webhook.lastDelivery
                    ? `· last ${webhook.lastDelivery.event} ${webhook.lastDelivery.status} ${formatRelativeTime(Date.parse(webhook.lastDelivery.at))}`
                    : "· no deliveries yet"}
                </span>
              </span>
              <span>
                <button type="button" onClick={() => void act(() => pingWebhook(pageId, webhook.id), "Test event sent.")}>
                  Test
                </button>
                <button type="button" onClick={() => void act(() => deleteWebhook(pageId, webhook.id), "Webhook removed.")}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
