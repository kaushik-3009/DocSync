import { z } from "zod/v4";
import { getExistingRole } from "../../auth/rbac.js";
import { recordAudit } from "../../auth/audit.js";
import { HttpError } from "../guards.js";
import { bearer, pageIdSchema, pageParams, type RoutePlugin } from "./types.js";

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);

export const exportRoutes: RoutePlugin = async (app, { deps, guards }) => {
  function jobQueues() {
    if (!deps.jobQueues) throw new HttpError(503, "exports require REDIS_URL and DATABASE_URL");
    return deps.jobQueues;
  }

  app.post("/pages/:pageId/export", { schema: { tags: ["exports"], security: bearer, params: pageParams } }, async (request, reply) => {
    const queues = jobQueues();
    const { pageId } = request.params;
    await guards.pageRole(request, pageId);
    const jobId = await queues.enqueuePdfExport(pageId);
    const user = guards.currentUser(request);
    if (user && deps.pool) recordAudit(deps.pool, { userId: user.userId, pageId, event: "export_requested" });
    return reply.code(202).send({ pageId, jobId });
  });

  app.get(
    "/pages/:pageId/export/:jobId",
    { schema: { tags: ["exports"], security: bearer, params: z.object({ pageId: pageIdSchema, jobId: idSchema }) } },
    async (request) => {
      const queues = jobQueues();
      const { pageId, jobId } = request.params;
      await guards.pageRole(request, pageId);
      const status = await queues.getPdfExportJobStatus(jobId);
      // A job for another page is indistinguishable from a missing one.
      if (!status || status.pageId !== pageId) throw new HttpError(404, "no such export job");
      const { pageId: _pageId, ...response } = status;
      return response;
    }
  );

  // Authenticates before the lookup so unauthenticated callers can't probe
  // which export ids exist; a page the caller can't read answers 404 too.
  app.get(
    "/exports/:exportId",
    { schema: { tags: ["exports"], security: bearer, params: z.object({ exportId: idSchema }) } },
    async (request, reply) => {
      if (!deps.exportStorage) throw new HttpError(503, "exports require DATABASE_URL");
      const user = guards.currentUser(request);
      const location = await deps.exportStorage.locate(request.params.exportId);
      if (!location) throw new HttpError(404, "no such export");
      if (user && !(await getExistingRole(guards.pool(), location.pageId, user.userId))) throw new HttpError(404, "no such export");
      if ("redirectUrl" in location) {
        // Browser fetch() clients ask for JSON and navigate themselves, which
        // keeps their Authorization header away from the object store.
        if (request.headers.accept?.includes("application/json")) return { downloadUrl: location.redirectUrl };
        return reply.redirect(location.redirectUrl, 302);
      }
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${location.pageId}.pdf"`)
        .send(location.body);
    }
  );
};
