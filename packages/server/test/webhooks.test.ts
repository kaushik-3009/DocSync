import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { signPayload, verifySignature, SIGNATURE_HEADER } from "../src/webhooks/signing.js";
import { createSafeAgent, isPrivateAddress, safePost, validateWebhookUrl } from "../src/webhooks/safe-fetch.js";
import { createWebhook, listWebhooks } from "../src/webhooks/store.js";
import { deliverWebhook } from "../src/webhooks/delivery.js";
import { loadWebhookPolicy } from "../src/webhooks/policy.js";
import { createUser } from "../src/auth/users.js";
import { createDocument } from "../src/documents/store.js";

describe("webhook signatures", () => {
  it("verifies a fresh signature and rejects tampering, wrong secrets and replays", () => {
    const body = JSON.stringify({ event: "page.updated" });
    const now = 1_800_000_000;
    const header = signPayload("whsec_test", body, now);
    expect(verifySignature("whsec_test", body, header, 300, now + 10)).toBe(true);
    expect(verifySignature("whsec_test", body.replace("updated", "deleted"), header, 300, now)).toBe(false);
    expect(verifySignature("whsec_other", body, header, 300, now)).toBe(false);
    expect(verifySignature("whsec_test", body, header, 300, now + 301)).toBe(false);
    expect(verifySignature("whsec_test", body, "garbage", 300, now)).toBe(false);
  });
});

describe("webhook policy", () => {
  it("allows local delivery only outside production", () => {
    expect(loadWebhookPolicy({})).toEqual({ allowPrivateNetworks: false, allowInsecure: false });
    expect(loadWebhookPolicy({ WEBHOOKS_ALLOW_LOCAL: "true", NODE_ENV: "development" }).allowPrivateNetworks).toBe(true);
    expect(() => loadWebhookPolicy({ WEBHOOKS_ALLOW_LOCAL: "true", NODE_ENV: "production" })).toThrow(/production/);
  });
});

describe("SSRF protection", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata service
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["93.184.216.34", false],
    ["2606:4700:4700::1111", false],
  ])("classifies %s as private=%s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it("validates webhook URLs before they are stored", () => {
    expect(validateWebhookUrl("https://hooks.example.com/docsync").host).toBe("hooks.example.com");
    expect(() => validateWebhookUrl("http://hooks.example.com")).toThrow(/https/);
    expect(() => validateWebhookUrl("https://localhost/hook")).toThrow(/private/);
    expect(() => validateWebhookUrl("https://10.0.0.5/hook")).toThrow(/private/);
    expect(() => validateWebhookUrl("https://[::1]/hook")).toThrow(/private/);
    expect(() => validateWebhookUrl("https://user:pass@hooks.example.com")).toThrow(/credentials/);
    expect(() => validateWebhookUrl("not a url")).toThrow(/valid URL/);
    expect(validateWebhookUrl("http://127.0.0.1:9999/hook", { allowInsecure: true, allowPrivateNetworks: true }).port).toBe("9999");
  });
});

describe("webhook delivery", () => {
  let receiver: Server;
  let port: number;
  let received: Array<{ headers: IncomingMessage["headers"]; body: string }>;
  let respond: (request: IncomingMessage) => { status: number; headers?: Record<string, string> };
  let pool: Pool;

  beforeEach(async () => {
    received = [];
    respond = () => ({ status: 204 });
    receiver = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body });
        const { status, headers } = respond(request);
        response.writeHead(status, headers).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    port = (receiver.address() as AddressInfo).port;
    pool = await createTestPool();
  });

  afterEach(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  async function hook() {
    const owner = await createUser(pool, "owner@example.com", "pw");
    const page = await createDocument(pool, owner.id, "Hooked");
    return { pageId: page.id, ...(await createWebhook(pool, page.id, `http://127.0.0.1:${port}/hook`, owner.id)) };
  }

  it("refuses private destinations at connect time: IP literals and hostnames that resolve to them", async () => {
    const agent = createSafeAgent();
    const blockedBy = async (url: string) => {
      const error = await safePost(agent, url, "{}", {}).then(
        () => null,
        (err: Error & { cause?: Error }) => err
      );
      return error?.cause?.name ?? error?.name;
    };
    expect(await blockedBy(`http://127.0.0.1:${port}/hook`)).toBe("BlockedDestinationError");
    expect(await blockedBy(`http://[::1]:${port}/hook`)).toBe("BlockedDestinationError");
    expect(await blockedBy("http://169.254.169.254/latest/meta-data/")).toBe("BlockedDestinationError");
    expect(await blockedBy(`http://localhost:${port}/hook`)).toBe("BlockedDestinationError");
    expect(received).toHaveLength(0);
  });

  it("delivers a signed event the receiver can verify, and logs it", async () => {
    const { webhook, secret, pageId } = await hook();
    await deliverWebhook(
      { pool, agent: createSafeAgent({ allowPrivateNetworks: true }) },
      { deliveryId: "d1", webhookId: webhook.id, event: "page.updated", payload: { pageId, seq: 7 } },
      1
    );
    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    expect(JSON.parse(delivery.body)).toEqual({ id: "d1", event: "page.updated", pageId, seq: 7 });
    expect(delivery.headers["x-docsync-event"]).toBe("page.updated");
    expect(verifySignature(secret, delivery.body, String(delivery.headers[SIGNATURE_HEADER]))).toBe(true);
    expect((await listWebhooks(pool, pageId))[0]!.lastDelivery).toMatchObject({ status: "delivered", responseStatus: 204 });
  });

  it("does not follow redirects and records the failure for retry", async () => {
    const { webhook, pageId } = await hook();
    respond = () => ({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    await expect(
      deliverWebhook(
        { pool, agent: createSafeAgent({ allowPrivateNetworks: true }) },
        { deliveryId: "d2", webhookId: webhook.id, event: "page.updated", payload: { pageId } },
        3
      )
    ).rejects.toThrow(/HTTP 302/);
    expect(received).toHaveLength(1);
    expect((await listWebhooks(pool, pageId))[0]!.lastDelivery).toMatchObject({ status: "failed", responseStatus: 302 });
  });

  it("never exposes secrets when listing", async () => {
    const { pageId, secret } = await hook();
    expect(JSON.stringify(await listWebhooks(pool, pageId))).not.toContain(secret);
  });
});
