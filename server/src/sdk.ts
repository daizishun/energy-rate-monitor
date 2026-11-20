// Minimal local replacement for `@hatch/space-sdk` (server side).
//
// The original artifact ran inside Muse, where the SDK provided:
//   - `defineAction` — a `{ request, response, handler }` action definition
//     with zod schemas, dispatched by the platform worker;
//   - `Ctx` — per-invocation context with `ctx.db()` (drizzle), an LLM
//     `ctx.inference` client used only to translate retailer note text,
//     and `ctx.invalidateQueries()` to tell open clients to refetch.
//
// The standalone build re-implements that surface with no platform:
//   - `defineAction` just returns the spec; `server/src/index.ts`
//     validates request/response against the zod schemas and dispatches
//     over HTTP POST /actions.
//   - `ctx.db()` returns the process-wide drizzle + bun:sqlite instance
//     created in ./db.ts.
//   - `ctx.inference.complete()` is a stub that always throws: there is
//     no LLM provider in the standalone build. Its only caller,
//     `translateNoteOriginals` in actions.ts, already treats translation
//     as best-effort and falls back to a "translation unavailable, see
//     the expandable original" label, so refreshes keep working and the
//     retailer's English original stays viewable behind the expand
//     toggle. (To restore translation, wire a provider here and make
//     `complete` return the validated parsed result.)
//   - `ctx.invalidateQueries()` is a no-op: with no platform push
//     channel, clients refetch via React Query (mutations invalidate
//     the dashboard query on success; the page also polls).

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

export { z };

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
}

export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

const inferenceStub: InferenceClient = {
  async complete() {
    throw new Error(
      "standalone build: no inference provider is configured, so note translation is unavailable (the English original is still stored and shown behind the expand toggle)",
    );
  },
};

export interface Ctx {
  readonly slug: string;
  readonly db: <TSchema extends Record<string, unknown> = Record<string, never>>() => BunSQLiteDatabase<TSchema>;
  readonly inference: InferenceClient;
  invalidateQueries(): void;
}

export function createCtx(
  db: BunSQLiteDatabase<Record<string, never>>,
  slug = "energy-rate-monitor",
): Ctx {
  return {
    slug,
    db: (() => db) as Ctx["db"],
    inference: inferenceStub,
    invalidateQueries() {
      // No-op in the standalone build (see header comment).
    },
  };
}

export interface ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export function defineAction<
  Req extends z.ZodType,
  Res extends z.ZodType,
>(spec: ActionDefinition<Req, Res>): ActionDefinition<Req, Res> {
  return spec;
}

export type ActionsModule = Record<
  string,
  {
    request: z.ZodType;
    response: z.ZodType;
    handler: (ctx: Ctx, args: never) => Promise<unknown>;
  }
>;
