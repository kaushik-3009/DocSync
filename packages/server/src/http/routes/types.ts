import type { FastifyPluginAsync, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import type { AppDeps } from "../deps.js";
import type { Guards } from "../guards.js";

export interface RouteOptions {
  deps: AppDeps;
  guards: Guards;
}

/** A route module: a Fastify plugin that receives the app's dependencies. */
export type RoutePlugin = FastifyPluginAsync<RouteOptions, RawServerDefault, ZodTypeProvider>;

export const pageIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);
export const pageParams = z.object({ pageId: pageIdSchema });
export const bearer = [{ bearer: [] }];
