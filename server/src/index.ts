// Standalone server entry point.
//
//   bun run start        -> build, then serve on $PORT (default 3000)
//   bun server/src/index.ts -> run from source (same behaviour)
//
// On startup the database is migrated (drizzle/ applied to
// $DATABASE_PATH, default ./app.db) and seeded with the public
// retailer list + generic default settings when empty — see ./db.ts.
// The server then serves:
//   - POST /actions  { action, args } -> the action's zod-validated
//     response as { data }, or { error } with a 4xx/5xx status.
//   - GET  / and any static file under client/dist/ (the React build).
//   - The daily auto-update: the `autoRefresh` action runs once at
//     startup and then every 24h while the server is running. It only
//     fetches from the CDR feed when the user's configured interval
//     (default weekly) has elapsed, so a fresh install does nothing
//     until an address exists and its interval comes due.

import { join, normalize, resolve } from "node:path";
import { Actions } from "./actions";
import type { Ctx } from "./sdk";
import { createCtx } from "./sdk";
import { databasePath, ensureActiveAddress, initDb } from "./db";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const db = initDb();
await ensureActiveAddress(db);
const ctx = createCtx(db as never);

const CLIENT_DIST = resolve(process.cwd(), "client", "dist");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleAction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求体不是有效的 JSON。" }, 400);
  }
  const actionName =
    body != null && typeof body === "object"
      ? (body as Record<string, unknown>).action
      : undefined;
  const args =
    body != null && typeof body === "object"
      ? ((body as Record<string, unknown>).args ?? {})
      : {};
  if (typeof actionName !== "string" || !(actionName in Actions)) {
    return json({ error: `未知的 action：${String(actionName ?? "")}` }, 404);
  }
  const action = Actions[actionName as keyof typeof Actions];
  const parsedArgs = action.request.safeParse(args);
  if (!parsedArgs.success) {
    const first = parsedArgs.error.issues[0];
    return json(
      {
        error: first?.message ?? "请求参数不正确。",
        issues: parsedArgs.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }
  try {
    // The union of action definitions has per-action handler types;
    // the request was already validated against this action's schema.
    const handler = action.handler as unknown as (
      ctx: Ctx,
      args: unknown,
    ) => Promise<unknown>;
    const result = await handler(ctx, parsedArgs.data);
    const parsedResult = action.response.safeParse(result);
    if (!parsedResult.success) {
      console.error(
        `[actions] ${actionName} returned an invalid response:`,
        parsedResult.error.issues,
      );
      return json({ error: "服务器返回的数据格式不正确。" }, 500);
    }
    return json({ data: parsedResult.data });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[actions] ${actionName} failed:`, message);
    return json({ error: message || "操作失败，请重试。" }, 500);
  }
}

async function handleStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(CLIENT_DIST, safe);
  if (!filePath.startsWith(CLIENT_DIST)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }
  if (pathname === "/index.html") {
    return new Response(
      "前端尚未编译：请先运行 bun run build，再运行 bun run start。",
      { status: 503 },
    );
  }
  return new Response("Not found", { status: 404 });
}

async function runAutoRefreshOnce(reason: string): Promise<void> {
  try {
    const action = Actions.autoRefresh;
    const result = await action.handler(ctx, {});
    console.log(
      `[auto-refresh] ${reason}: refreshed=${result.refreshed} — ${result.reason}`,
    );
  } catch (e) {
    console.error(
      `[auto-refresh] ${reason} failed:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions" && req.method === "POST") {
      return handleAction(req);
    }
    if (req.method === "GET") {
      return handleStatic(req);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `energy-rate-monitor listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port} (db: ${databasePath()})`,
);

// Daily auto-update while the server is running (the action itself
// gates on the user's configured interval; manual refresh is unaffected).
void runAutoRefreshOnce("startup");
setInterval(() => void runAutoRefreshOnce("daily tick"), 24 * 60 * 60 * 1000);
