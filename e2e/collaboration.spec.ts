import { expect, test } from "@playwright/test";
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
