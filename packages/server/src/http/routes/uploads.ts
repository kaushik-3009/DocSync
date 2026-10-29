import type { FastifyRequest } from "fastify";
import { z } from "zod/v4";
import { ALLOWED_IMAGE_TYPES, findUpload, InlineUploadStorage, matchesImageType, MAX_UPLOAD_BYTES } from "../../uploads/storage.js";
import { HttpError } from "../guards.js";
import { bearer, pageIdSchema, pageParams, type RoutePlugin } from "./types.js";

const uploadIdSchema = z.string().uuid();

/** Origin of this API as the client reached it (honours X-Forwarded-* only
 *  when TRUST_PROXY is set). */
const apiBaseUrl = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

export const uploadRoutes: RoutePlugin = async (app, { deps, guards }) => {
  function storage() {
    if (!deps.uploadStorage) throw new HttpError(503, "uploads require DATABASE_URL");
    return deps.uploadStorage;
  }

  app.addContentTypeParser([...ALLOWED_IMAGE_TYPES], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) =>
    done(null, body)
  );

  // Step 1: approve an upload (type and exact size) and get where to send it.
  app.post(
    "/pages/:pageId/uploads",
    {
      schema: {
        tags: ["uploads"],
        security: bearer,
        params: pageParams,
        body: z.object({ contentType: z.enum(ALLOWED_IMAGE_TYPES), size: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }),
      },
    },
    async (request, reply) => {
      const user = guards.currentUser(request);
      const { pageId } = request.params;
      await guards.pageRole(request, pageId, "editor", "editor or owner access required to add images");
      const result = await storage().begin({
        pageId,
        userId: user?.userId ?? null,
        contentType: request.body.contentType,
        sizeBytes: request.body.size,
        apiBaseUrl: apiBaseUrl(request),
      });
      return reply.code(201).send(result);
    }
  );

  // Step 2 (local storage only; S3 receives the bytes directly).
  app.put(
    "/uploads/:uploadId",
    { bodyLimit: MAX_UPLOAD_BYTES, schema: { tags: ["uploads"], security: bearer, params: z.object({ uploadId: uploadIdSchema }) } },
    async (request, reply) => {
      const store = storage();
      if (!(store instanceof InlineUploadStorage)) throw new HttpError(404, "not found");
      const user = guards.currentUser(request);
      const upload = await findUpload(guards.pool(), request.params.uploadId);
      if (!upload || (user && upload.createdBy !== user.userId)) throw new HttpError(404, "no such upload");
      if (upload.hasData) throw new HttpError(409, "this upload has already been completed");
      const bytes = request.body as Buffer;
      if (!Buffer.isBuffer(bytes) || request.headers["content-type"] !== upload.contentType) {
        throw new HttpError(415, `expected ${upload.contentType}`);
      }
      if (bytes.length !== upload.sizeBytes) throw new HttpError(400, "file size does not match the approved upload");
      // The declared type is not trusted: the bytes must actually be that format.
      if (!matchesImageType(bytes, upload.contentType)) throw new HttpError(415, "file contents do not match the declared image type");
      await store.store(upload.id, bytes);
      return reply.code(204).send();
    }
  );

  // A short-lived URL an <img> can load, issued after the page access check.
  app.get(
    "/pages/:pageId/uploads/:uploadId/url",
    { schema: { tags: ["uploads"], security: bearer, params: z.object({ pageId: pageIdSchema, uploadId: uploadIdSchema }) } },
    async (request) => {
      const { pageId, uploadId } = request.params;
      await guards.pageRole(request, pageId);
      const upload = await findUpload(guards.pool(), uploadId);
      // An upload is only readable through the page it belongs to.
      if (!upload || upload.pageId !== pageId) throw new HttpError(404, "no such image");
      if (storage() instanceof InlineUploadStorage && !upload.hasData) throw new HttpError(404, "image upload has not completed");
      return { url: await storage().readUrl(upload, apiBaseUrl(request)), expiresInSeconds: 300 };
    }
  );

  // Local storage only: serves bytes for a signed, expiring URL. Hardened so
  // the response can never be interpreted as a document.
  app.get(
    "/uploads/:uploadId/content",
    {
      schema: {
        tags: ["uploads"],
        params: z.object({ uploadId: uploadIdSchema }),
        querystring: z.object({ expires: z.coerce.number().int(), signature: z.string().regex(/^[0-9a-f]{64}$/) }),
      },
    },
    async (request, reply) => {
      const store = storage();
      if (
        !(store instanceof InlineUploadStorage) ||
        !store.verify(request.params.uploadId, request.query.expires, request.query.signature)
      ) {
        throw new HttpError(404, "not found");
      }
      const upload = await findUpload(guards.pool(), request.params.uploadId);
      const bytes = upload ? await store.read(upload.id) : null;
      if (!upload || !bytes) throw new HttpError(404, "not found");
      return reply
        .header("content-type", upload.contentType)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, max-age=300")
        .header("cross-origin-resource-policy", "cross-origin")
        .send(bytes);
    }
  );
};
