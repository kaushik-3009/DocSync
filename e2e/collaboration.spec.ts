import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { verifySignature } from "../packages/server/src/webhooks/signing.js";
import { controllableNetwork, createDocument, openPage, registerUser, share, signedInContext } from "./helpers.js";

test("a new user can sign up through the UI and create a page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Need an account/ }).click();
  await page.getByPlaceholder("you@example.com").fill(`ui-${Date.now()}@e2e.test`);
  await page.getByPlaceholder("At least 8 characters").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("button", { name: "+ New page" }).click();
  await expect(page).toHaveURL(/[?&]page=/);
  await expect(page.locator(".doc-title-field")).toBeVisible();
});

test("edits by one collaborator appear live for another", async ({ browser }) => {
  const owner = await registerUser("owner");
  const editor = await registerUser("editor");
  const pageId = await createDocument(owner, "Shared plan");
  await share(owner, pageId, editor, "editor");

  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  const editorPage = await openPage(await signedInContext(browser, editor), pageId);

  const ownerTitle = ownerPage.locator(".doc-title-field");
  await ownerTitle.click();
  await ownerPage.keyboard.type("Launch checklist");
  await expect(editorPage.locator(".doc-title-field")).toHaveText("Launch checklist");

  // And back the other way.
  const editorTitle = editorPage.locator(".doc-title-field");
  await editorTitle.click();
  await editorPage.keyboard.press("End");
  await editorPage.keyboard.type(" v2");
  await expect(ownerTitle).toHaveText("Launch checklist v2");
});

test("a viewer's local edits never reach other collaborators", async ({ browser }) => {
  const owner = await registerUser("owner");
  const viewer = await registerUser("viewer");
  const pageId = await createDocument(owner, "Read only");
  await share(owner, pageId, viewer, "viewer");

  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  const viewerPage = await openPage(await signedInContext(browser, viewer), pageId);

  await ownerPage.locator(".doc-title-field").click();
  await ownerPage.keyboard.type("Owner text");
  await expect(viewerPage.locator(".doc-title-field")).toHaveText("Owner text");

  // The UI renders read-only for viewers; force a local edit anyway to prove
  // the server, not just the interface, rejects it.
  await viewerPage.locator(".doc-title-field").evaluate((element) => {
    element.setAttribute("contenteditable", "true");
  });
  await viewerPage.locator(".doc-title-field").click();
  await viewerPage.keyboard.press("End");
  await viewerPage.keyboard.type(" hacked");
  // The edit really happened locally...
  await expect(viewerPage.locator(".doc-title-field")).toContainText("hacked");
  // ...but the gateway dropped it before persistence and fanout.
  await ownerPage.waitForTimeout(1_000);
  await expect(ownerPage.locator(".doc-title-field")).toHaveText("Owner text");
});

test("a user without access sees the access-denied state", async ({ browser }) => {
  const owner = await registerUser("owner");
  const stranger = await registerUser("stranger");
  const pageId = await createDocument(owner, "Private");

  const strangerPage = await openPage(await signedInContext(browser, stranger), pageId);
  await expect(strangerPage.getByText(/access|permission/i).first()).toBeVisible();
  await expect(strangerPage.locator(".doc-title-field")).not.toHaveText("Private");
});

test("the Authors panel credits each collaborator's text", async ({ browser }) => {
  const owner = await registerUser("ada");
  const editor = await registerUser("grace");
  const pageId = await createDocument(owner, "Credits");
  await share(owner, pageId, editor, "editor");

  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  const editorPage = await openPage(await signedInContext(browser, editor), pageId);
  await ownerPage.locator(".doc-title-field").click();
  await ownerPage.keyboard.type("Plan by Ada");
  await expect(editorPage.locator(".doc-title-field")).toHaveText("Plan by Ada");
  await editorPage.locator(".doc-title-field").click();
  await editorPage.keyboard.press("End");
  await editorPage.keyboard.type(", reviewed by Grace");
  await expect(ownerPage.locator(".doc-title-field")).toHaveText("Plan by Ada, reviewed by Grace");

  await ownerPage.getByRole("button", { name: "Authors" }).click();
  const legend = ownerPage.getByRole("list", { name: "Contribution by author" });
  await expect(legend).toContainText(owner.email);
  await expect(legend).toContainText(editor.email);
  await expect(ownerPage.locator(".authorship-document h2 .authorship-span")).toHaveCount(2);
});

test("edits made offline survive closing the tab and sync on reconnect", async ({ browser }) => {
  const owner = await registerUser("owner");
  const editor = await registerUser("roamer");
  const pageId = await createDocument(owner, "Field notes");
  await share(owner, pageId, editor, "editor");

  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  const editorContext = await signedInContext(browser, editor);
  const network = await controllableNetwork(editorContext);
  let editorPage = await openPage(editorContext, pageId);
  await ownerPage.locator(".doc-title-field").click();
  await ownerPage.keyboard.type("Notes");
  await expect(editorPage.locator(".doc-title-field")).toHaveText("Notes");
  await expect(editorPage.getByText("Synced")).toBeVisible();

  await network.goOffline();
  await editorPage.locator(".doc-title-field").click();
  await editorPage.keyboard.press("End");
  await editorPage.keyboard.type(" from the train");
  await expect(editorPage.getByText(/^Offline/)).toBeVisible();
  // The edit exists only on this device: closing the tab drops the in-memory
  // document, leaving the IndexedDB copy as its only home.
  await editorPage.waitForTimeout(500);
  await editorPage.close();
  await ownerPage.waitForTimeout(500);
  await expect(ownerPage.locator(".doc-title-field")).toHaveText("Notes");

  await network.goOnline();
  editorPage = await openPage(editorContext, pageId);
  await expect(ownerPage.locator(".doc-title-field")).toHaveText("Notes from the train");
  await expect(editorPage.locator(".doc-title-field")).toHaveText("Notes from the train");
});

test("meaning search ranks the page that is about the query first", async ({ browser }) => {
  const owner = await registerUser("searcher");
  const context = await signedInContext(browser, owner);
  // Two pages, so ranking (not just "the only page") is what is tested.
  for (const [title, body] of [
    ["Team offsite", "Lunch options, the agenda, and who is bringing snacks to the offsite."],
    ["Incident runbook", "When the primary database fails, promote the replica and repoint the gateways."],
  ]) {
    const page = await openPage(context, await createDocument(owner, title!));
    await page.locator(".doc-title-field").click();
    await page.keyboard.type(title!);
    await page.locator("[data-placeholder=\"Type '/' for commands\"]").first().click();
    await page.keyboard.type(body!);
    await expect(page.getByText("Synced")).toBeVisible();
    await page.close();
  }

  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.getByRole("tab", { name: "Meaning" }).click();
  const input = page.getByRole("dialog", { name: "Search pages" }).locator("input");
  // Indexing runs in a background job after the edits commit.
  await expect(async () => {
    await input.fill("");
    await input.fill("database failover procedure");
    await expect(page.locator(".search-result-item")).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.locator(".search-result-item").first()).toContainText("Incident runbook");
  await expect(page.locator(".search-result-item").nth(1)).toContainText("Team offsite");
});

test("an owner can publish a read-only link and revoke it", async ({ browser }) => {
  const owner = await registerUser("publisher");
  const pageId = await createDocument(owner, "Release notes");
  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  await ownerPage.locator(".doc-title-field").click();
  await ownerPage.keyboard.type("Release notes");
  await ownerPage.locator("[data-placeholder=\"Type '/' for commands\"]").first().click();
  await ownerPage.keyboard.type("Version 2 ships on Friday.");
  await expect(ownerPage.getByText("Synced")).toBeVisible();

  await ownerPage.getByRole("button", { name: "Share" }).click();
  await ownerPage.getByRole("button", { name: "Create link" }).click();
  const url = await ownerPage.getByLabel("New public link").inputValue();
  expect(url).toContain("?share=");

  // A signed-out visitor sees the page, read-only.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(url);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Release notes");
  await expect(visitor.getByText("Version 2 ships on Friday.")).toBeVisible();
  await expect(visitor.locator("[contenteditable]")).toHaveCount(0);

  await ownerPage.getByRole("button", { name: "Revoke" }).click();
  await expect(ownerPage.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await visitor.reload();
  await expect(visitor.getByRole("alert")).toContainText("invalid or has been revoked");
});

test("edits trigger a signed webhook the receiver can verify", async ({ browser }) => {
  const deliveries: Array<{ body: string; signature: string }> = [];
  const receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      deliveries.push({ body, signature: String(request.headers["x-docsync-signature"]) });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const port = (receiver.address() as AddressInfo).port;

  try {
    const owner = await registerUser("integrator");
    const pageId = await createDocument(owner, "Changelog");
    const page = await openPage(await signedInContext(browser, owner), pageId);
    await page.getByRole("button", { name: "Share" }).click();
    await page.getByLabel("Webhooks").getByRole("textbox").fill(`http://127.0.0.1:${port}/hook`);
    await page.getByRole("button", { name: "Add" }).click();
    const secret = await page.getByLabel("Webhook signing secret").inputValue();
    await page.keyboard.press("Escape");

    await page.locator(".doc-title-field").click();
    await page.keyboard.type("Changelog v2");
    await expect.poll(() => deliveries.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const event = JSON.parse(deliveries[0]!.body) as { event: string; pageId: string; seq: number };
    expect(event).toMatchObject({ event: "page.updated", pageId });
    expect(event.seq).toBeGreaterThan(0);
    expect(verifySignature(secret, deliveries[0]!.body, deliveries[0]!.signature)).toBe(true);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("an image uploaded by one collaborator renders for another", async ({ browser }) => {
  const owner = await registerUser("photographer");
  const editor = await registerUser("reviewer");
  const pageId = await createDocument(owner, "Moodboard");
  await share(owner, pageId, editor, "editor");
  const ownerPage = await openPage(await signedInContext(browser, owner), pageId);
  const editorPage = await openPage(await signedInContext(browser, editor), pageId);

  await ownerPage.locator("[data-placeholder=\"Type '/' for commands\"]").first().click();
  await ownerPage.keyboard.type("/image");
  await ownerPage.keyboard.press("Enter");
  // A real 1x1 PNG; the server checks the magic bytes match the type.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await ownerPage.locator('input[type="file"]').setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });

  for (const page of [ownerPage, editorPage]) {
    const image = page.locator(".image-block img");
    await expect(image).toBeVisible();
    // Decoded by the browser, not just present in the DOM.
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  }
});
