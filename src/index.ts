import { ADMIN_HTML } from "./admin.ts";
import { QueueStore } from "./queue-store.ts";
import type { Env } from "./types.ts";

export { QueueStore };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function securityHeaders(): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(ADMIN_HTML, { headers: securityHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "facebook-page-rotator", status: "ok" });
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 24) {
      return json({ error: "ADMIN_SECRET is not configured or is too short. Set a strong secret in Cloudflare." }, 503);
    }

    const header = request.headers.get("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !constantTimeEqual(provided, env.ADMIN_SECRET)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const id = env.STATE.idFromName("facebook-page-rotator-state-v1");
    const stub = env.STATE.get(id);
    return stub.fetch(request);
  },

  async scheduled(controller: { cron: string; scheduledTime: number }, env: Env): Promise<void> {
    const id = env.STATE.idFromName("facebook-page-rotator-state-v1");
    const stub = env.STATE.get(id);
    const response = await stub.fetch(new Request("https://queue-store.internal/internal/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "scheduled", cron: controller.cron, scheduledTime: controller.scheduledTime }),
    }));
    const result = await response.text();
    console.log("scheduled publisher result", response.status, result.slice(0, 1_200));
  },
} satisfies {
  fetch(request: Request, env: Env): Promise<Response>;
  scheduled(controller: { cron: string; scheduledTime: number }, env: Env): Promise<void>;
};
