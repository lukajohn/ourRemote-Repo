import assert from "node:assert/strict";
import { QueueStore } from "../src/queue-store.ts";

function memoryContext() {
  const data = new Map();
  const storage = {
    async get(key) {
      const value = data.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      return data.delete(key);
    },
    async transaction(callback) {
      return callback({
        async get(key) {
          const value = data.get(key);
          return value === undefined ? undefined : structuredClone(value);
        },
        async put(key, value) {
          data.set(key, structuredClone(value));
        },
        async delete(key) {
          return data.delete(key);
        },
      });
    },
  };
  return { storage };
}

function fakeMedia() {
  const files = new Map();
  return {
    files,
    async put(key, value) { files.set(key, value); },
    async get(key) {
      const value = files.get(key);
      if (!value) return null;
      const bytes = value instanceof ArrayBuffer ? value : await value.arrayBuffer();
      return { async arrayBuffer() { return bytes; } };
    },
    async delete(key) { files.delete(key); },
  };
}

function jsonRequest(path, body, method = "POST") {
  return new Request("https://worker.test" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

async function test(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
}

const realNow = Date.now;
const realFetch = globalThis.fetch;
let fakeNow = 1_800_000_000_000;
Date.now = () => fakeNow;

try {
  await test("queue API deduplicates exact content", async () => {
    const store = new QueueStore(memoryContext(), { MEDIA: fakeMedia() });
    const first = await read(await store.fetch(jsonRequest("/api/content", { text: "same post" })));
    const second = await read(await store.fetch(jsonRequest("/api/content", { text: "same post" })));
    assert.equal(first.status, 201);
    assert.equal(first.body.added, 1);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicates, 1);
    assert.equal((await read(await store.fetch(new Request("https://worker.test/api/content", { method: "GET" })))).body.items.length, 1);
  });

  await test("successful publishing is FIFO, authenticated, and has a 24-hour repeat guard", async () => {
    const store = new QueueStore(memoryContext(), {
      MEDIA: fakeMedia(),
      FACEBOOK_PAGE_ID: "123456",
      FACEBOOK_PAGE_ACCESS_TOKEN: "page-token-test",
      META_GRAPH_API_VERSION: "v26.0",
    });
    await store.fetch(jsonRequest("/api/content", { items: [{ text: "oldest" }, { text: "newest" }] }));
    await store.fetch(jsonRequest("/api/resume", {}));
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), form: init.body });
      return new Response(JSON.stringify({ id: `123456_${calls.length}` }), { status: 200 });
    };

    const first = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(first.body.status, "published");
    assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/123456/feed");
    assert.equal(calls[0].auth, "Bearer page-token-test");
    assert.equal(calls[0].form.get("message"), "oldest");

    fakeNow += 3 * 60 * 60 * 1000;
    const second = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(second.body.status, "published");
    assert.equal(calls[1].form.get("message"), "newest");

    fakeNow += 3 * 60 * 60 * 1000;
    const third = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(third.body.status, "skipped");
    assert.match(third.body.message, /24-hour/);
    assert.equal(calls.length, 2, "cooldown must stop a too-soon duplicate");

    fakeNow = 1_800_000_000_000 + 24 * 60 * 60 * 1000;
    const fourth = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(fourth.body.status, "published");
    assert.equal(calls[2].form.get("message"), "oldest");
  });

  await test("transport timeout locks the queue until manual reconciliation", async () => {
    fakeNow = 1_800_000_000_000;
    const store = new QueueStore(memoryContext(), {
      MEDIA: fakeMedia(),
      FACEBOOK_PAGE_ID: "123456",
      FACEBOOK_PAGE_ACCESS_TOKEN: "page-token-test",
      META_GRAPH_API_VERSION: "v26.0",
    });
    await store.fetch(jsonRequest("/api/content", { text: "network ambiguity" }));
    await store.fetch(jsonRequest("/api/resume", {}));
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("simulated socket timeout"); };
    const first = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(first.body.status, "ambiguous");
    const second = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(second.body.status, "blocked");
    assert.equal(calls, 1, "ambiguous attempt must not be automatically retried");

    fakeNow += 10 * 60 * 1000;
    const reconcile = await read(await store.fetch(jsonRequest("/api/reconcile", { decision: "not_posted" })));
    assert.equal(reconcile.status, 200);
    const status = (await read(await store.fetch(new Request("https://worker.test/api/status", { method: "GET" })))).body;
    assert.equal(status.inFlight, null);
    assert.equal(status.queueCount, 1);
  });

  await test("configuration errors clear a reservation rather than falsely treating them as a network ambiguity", async () => {
    fakeNow = 1_800_000_000_000;
    const store = new QueueStore(memoryContext(), { MEDIA: fakeMedia() });
    await store.fetch(jsonRequest("/api/content", { text: "will not post without token" }));
    await store.fetch(jsonRequest("/api/resume", {}));
    const result = await read(await store.fetch(jsonRequest("/internal/tick", { reason: "scheduled" })));
    assert.equal(result.body.status, "error");
    const status = (await read(await store.fetch(new Request("https://worker.test/api/status", { method: "GET" })))).body;
    assert.equal(status.inFlight, null);
    assert.match(status.lastError, /FACEBOOK_PAGE_ID/);
  });
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}

console.log("All Worker integration tests passed.");
