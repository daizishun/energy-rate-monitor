// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `/actions` (served by `server/src/index.ts`) and returns the typed
// response (`{ data }`), throwing an Error carrying the server's
// `{ error }` message otherwise.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import type {
  input as ZodInput,
  output as ZodOutput,
  ZodType,
} from "zod";

type ActionShape = {
  request: ZodType;
  response: ZodType;
};

export type ActionClient<A extends Record<string, ActionShape>> = {
  [K in keyof A]: (
    args: ZodInput<A[K]["request"]>,
  ) => Promise<ZodOutput<A[K]["response"]>>;
};

/**
 * Request shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiRequest } from "./api";
 *     type Filter = ApiRequest<typeof api, "listArticles">;
 */
export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

/**
 * Response shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiResponse } from "./api";
 *     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
 */
export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

function createActionClient<A extends Record<string, ActionShape>>(
  endpoint = "/actions",
): ActionClient<A> {
  return new Proxy({} as ActionClient<A>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally") {
        return undefined;
      }
      return async (args: unknown) => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: name, args: args ?? {} }),
        });
        const body = (await res.json().catch(() => null)) as {
          data?: unknown;
          error?: unknown;
        } | null;
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : `action ${name} failed (HTTP ${res.status})`,
          );
        }
        if (body != null && typeof body === "object" && "error" in body && body.error) {
          throw new Error(`action ${name} error: ${String(body.error)}`);
        }
        return body?.data;
      };
    },
  });
}

export const api = createActionClient<typeof Actions>();
