import {
  MAX_IMAGE_BYTES,
  MAX_QUEUE_ITEMS,
  MIN_ITEM_REPEAT_GAP_MS,
  MIN_SLOT_INTERVAL_MS,
  RECONCILE_AFTER_MS,
  fingerprintContent,
  initialState,
  itemRepeatEligibility,
  slotEligibility,
  normalizePublicImageUrl,
  normalizeState,
  normalizeText,
  publicItem,
  selectCandidate,
  sha256Hex,
} from "./logic.ts";
import type {
  ContentItem,
  DurableObjectState,
  DurableObjectTransaction,
  Env,
  GraphPublishResult,
  PreparedItem,
  StoreState,
} from "./types.ts";

const STATE_KEY = "publisher-state";
const GRAPH_TIMEOUT_MS = 20_000;
const API_BODY_LIMIT = 1_000_000;
const MULTIPART_BODY_LIMIT = MAX_IMAGE_BYTES + 256_000;

class PublishTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishTransportError";
  }
}

type TickResult = {
  status: string;
  message: string;
  contentId?: string;
  postId?: string;
  nextEligibleAt?: number;
  ambiguous?: boolean;
};

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

function parseContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validatePreparedItem(textValue: unknown, imageUrlValue: unknown): { text: string; imageUrl?: string } {
  const text = normalizeText(textValue);
  const imageUrl = normalizePublicImageUrl(imageUrlValue);
  if (!text && !imageUrl) throw new Error("Provide post text or a public HTTPS image URL");
  return { text, imageUrl };
}

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function graphErrorMessage(payload: GraphPublishResult, status: number): string {
  const message = payload?.error?.message;
  const type = payload?.error?.type;
  const code = payload?.error?.code;
  const details = [typeof message === "string" ? message : "Facebook Graph API rejected the request", type, typeof code === "number" ? `code ${code}` : undefined]
    .filter(Boolean).join(" · ");
  return `Facebook API HTTP ${status}: ${details}`.slice(0, 700);
}

export class QueueStore {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private async readState(transaction?: DurableObjectTransaction): Promise<StoreState> {
    const storage = transaction ?? this.ctx.storage;
    return normalizeState(await storage.get<unknown>(STATE_KEY));
  }

  private async writeState(state: StoreState, transaction?: DurableObjectTransaction): Promise<void> {
    const storage = transaction ?? this.ctx.storage;
    await storage.put(STATE_KEY, state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/internal/tick" && request.method === "POST") {
        let reason: "scheduled" | "manual" = "scheduled";
        try {
          const body = await request.json() as { reason?: string };
          if (body?.reason === "manual") reason = "manual";
        } catch {
          // Internal scheduled requests need no body, so retain the default.
        }
        return json(await this.runTick(reason));
      }
      if (path === "/api/status" && request.method === "GET") return json(await this.getStatus());
      if (path === "/api/content" && request.method === "GET") return json(await this.getContent());
      if (path === "/api/content" && request.method === "POST") return await this.addContent(request);
      if (path.startsWith("/api/content/") && request.method === "DELETE") {
        return await this.deleteContent(decodeURIComponent(path.slice("/api/content/".length)));
      }
      if (path === "/api/pause" && request.method === "POST") return await this.setEnabled(false);
      if (path === "/api/resume" && request.method === "POST") return await this.setEnabled(true);
      if (path === "/api/preview" && request.method === "GET") return json(await this.preview());
      if (path === "/api/publish-now" && request.method === "POST") return json(await this.runTick("manual"));
      if (path === "/api/reconcile" && request.method === "POST") return await this.reconcile(request);
      return json({ error: "Not found or method not allowed" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      return json({ error: message.slice(0, 700) }, 400);
    }
  }

  private async getStatus() {
    const state = await this.readState();
    return {
      service: "facebook-page-rotator",
      enabled: state.enabled,
      queueCount: state.items.length,
      cycleNumber: state.cycleNumber,
      totalPublished: state.totalPublished,
      lastAttemptAt: state.lastAttemptAt,
      lastPublishedAt: state.lastPublishedAt,
      lastPostId: state.lastPostId,
      lastError: state.lastError,
      lastAction: state.lastAction,
      inFlight: state.inFlight ? {
        contentId: state.inFlight.contentId,
        startedAt: state.inFlight.startedAt,
        reason: state.inFlight.reason,
        ageMs: Date.now() - state.inFlight.startedAt,
        canReconcile: Date.now() - state.inFlight.startedAt >= RECONCILE_AFTER_MS,
      } : null,
    };
  }

  private async getContent() {
    const state = await this.readState();
    return { items: [...state.items].sort((a, b) => a.sequence - b.sequence).map(publicItem) };
  }

  private async setEnabled(enabled: boolean): Promise<Response> {
    const state = await this.ctx.storage.transaction(async (tx) => {
      const current = await this.readState(tx);
      current.enabled = enabled;
      current.lastAction = { at: Date.now(), message: enabled ? "Automation enabled." : "Automation paused." };
      await this.writeState(current, tx);
      return current;
    });
    return json({ ok: true, enabled: state.enabled, message: enabled ? "Automation enabled." : "Automation paused." });
  }

  private async addContent(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const declaredSize = parseContentLength(request);
    const isMultipart = contentType.includes("multipart/form-data");
    const limit = isMultipart ? MULTIPART_BODY_LIMIT : API_BODY_LIMIT;
    if (declaredSize !== null && declaredSize > limit) return json({ error: "Request body is too large" }, 413);

    if (isMultipart) {
      const form = await request.formData();
      const text = normalizeText(form.get("text"));
      const fileValue = form.get("file");
      const imageUrlValue = form.get("imageUrl");
      if (fileValue instanceof File && fileValue.size > 0) {
        if (imageUrlValue && String(imageUrlValue).trim()) return json({ error: "Choose an image upload or image URL, not both" }, 400);
        if (!text && !fileValue.size) return json({ error: "Provide text or an image" }, 400);
        if (fileValue.size > MAX_IMAGE_BYTES) return json({ error: "Image must be 8 MiB or smaller" }, 413);
        if (!["image/jpeg", "image/png"].includes(fileValue.type)) {
          return json({ error: "Only JPEG and PNG image uploads are supported" }, 415);
        }
        const bytes = await fileValue.arrayBuffer();
        const imageDigest = await sha256Hex(bytes);
        const fingerprint = await fingerprintContent(text, `upload-sha256:${imageDigest}`);
        const mediaKey = `uploads/${crypto.randomUUID()}`;
        await this.env.MEDIA.put(mediaKey, bytes, { httpMetadata: { contentType: fileValue.type } });
        const prepared: PreparedItem = {
          text,
          mediaKey,
          fileName: fileValue.name.replace(/[\r\n\\/]/g, "_").slice(0, 160) || "upload-image",
          mimeType: fileValue.type,
          fingerprint,
        };
        try {
          const result = await this.enqueuePrepared([prepared]);
          if (result.added.length === 0) await this.env.MEDIA.delete(mediaKey);
          return json({ added: result.added.length, duplicate: result.duplicates > 0, duplicates: result.duplicates, items: result.added.map(publicItem) }, result.added.length ? 201 : 200);
        } catch (error) {
          await this.env.MEDIA.delete(mediaKey);
          throw error;
        }
      }
      const valid = validatePreparedItem(text, imageUrlValue);
      const prepared = [{ ...valid, fingerprint: await fingerprintContent(valid.text, valid.imageUrl ?? "") }];
      const result = await this.enqueuePrepared(prepared);
      return json({ added: result.added.length, duplicate: result.duplicates > 0, duplicates: result.duplicates, items: result.added.map(publicItem) }, result.added.length ? 201 : 200);
    }

    if (!contentType.includes("application/json")) {
      return json({ error: "Send application/json or multipart/form-data" }, 415);
    }
    const rawBody: unknown = await request.json();
    const body = requireJsonObject(rawBody);
    const rawItems = Array.isArray(body.items) ? body.items : [body];
    if (rawItems.length < 1 || rawItems.length > 100) return json({ error: "Supply between 1 and 100 queue items" }, 400);

    const prepared: PreparedItem[] = [];
    for (const raw of rawItems) {
      const object = requireJsonObject(raw);
      const valid = validatePreparedItem(object.text, object.imageUrl);
      const fingerprint = await fingerprintContent(valid.text, valid.imageUrl ?? "");
      prepared.push({ ...valid, fingerprint });
    }
    const result = await this.enqueuePrepared(prepared);
    return json({
      added: result.added.length,
      duplicates: result.duplicates,
      items: result.added.map(publicItem),
      message: result.added.length ? "Content added to the queue in FIFO order." : "No new content was added; every item was already queued.",
    }, result.added.length ? 201 : 200);
  }

  private async enqueuePrepared(prepared: PreparedItem[]): Promise<{ added: ContentItem[]; duplicates: number }> {
    return this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      const known = new Set(state.items.map((item) => item.fingerprint));
      const added: ContentItem[] = [];
      let duplicates = 0;
      for (const input of prepared) {
        if (known.has(input.fingerprint)) {
          duplicates += 1;
          continue;
        }
        if (state.items.length + added.length >= MAX_QUEUE_ITEMS) {
          throw new Error(`Queue limit reached (${MAX_QUEUE_ITEMS} items)`);
        }
        const item: ContentItem = {
          id: crypto.randomUUID(),
          sequence: state.nextSequence + added.length,
          text: input.text,
          imageUrl: input.imageUrl,
          mediaKey: input.mediaKey,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fingerprint: input.fingerprint,
          createdAt: Date.now(),
          lastPostedAt: null,
          publishedCount: 0,
        };
        known.add(input.fingerprint);
        added.push(item);
      }
      state.items.push(...added);
      state.nextSequence += added.length;
      state.lastAction = { at: Date.now(), message: `Queue updated: ${added.length} added, ${duplicates} duplicate(s) skipped.` };
      await this.writeState(state, tx);
      return { added, duplicates };
    });
  }

  private async deleteContent(id: string): Promise<Response> {
    if (!id || id.length > 100) return json({ error: "Invalid content ID" }, 400);
    let mediaKey: string | undefined;
    const result = await this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      if (state.inFlight?.contentId === id) return { status: "in_flight" as const };
      const target = state.items.find((item) => item.id === id);
      if (!target) return { status: "missing" as const };
      mediaKey = target.mediaKey;
      state.items = state.items.filter((item) => item.id !== id);
      state.cycleSeenIds = state.cycleSeenIds.filter((seenId) => seenId !== id);
      state.lastAction = { at: Date.now(), message: `Removed queue item #${target.sequence}.` };
      await this.writeState(state, tx);
      return { status: "deleted" as const };
    });
    if (result.status === "in_flight") return json({ error: "This item has an unresolved publishing attempt; reconcile it first" }, 409);
    if (result.status === "missing") return json({ error: "Content item not found" }, 404);
    if (mediaKey) await this.env.MEDIA.delete(mediaKey);
    return json({ ok: true, message: "Content removed." });
  }

  private async preview(): Promise<Record<string, unknown>> {
    const state = await this.readState();
    if (!state.enabled) return { ready: false, message: "Automation is paused. Resume it to enable scheduled posting." };
    if (state.inFlight) return { ready: false, message: "Publishing is locked due to an unresolved attempt. Reconcile it after checking Facebook." };
    if (!state.items.length) return { ready: false, message: "The queue is empty; add text or image content." };
    const now = Date.now();
    const selection = selectCandidate(state);
    const item = selection.candidate;
    if (!item) return { ready: false, message: "No eligible queue item." };
    let nextEligibleAt = now;
    const messages: string[] = [];
    const slot = slotEligibility(state.lastAttemptAt, now);
    if (!slot.eligible && slot.nextEligibleAt !== undefined) {
      nextEligibleAt = Math.max(nextEligibleAt, slot.nextEligibleAt);
      messages.push("Three-hour slot interval has not elapsed.");
    }
    const repeat = itemRepeatEligibility(item, now);
    if (!repeat.eligible && repeat.nextEligibleAt !== undefined) {
      nextEligibleAt = Math.max(nextEligibleAt, repeat.nextEligibleAt);
      messages.push("The oldest FIFO item is inside its 24-hour repeat-protection window.");
    }
    return {
      ready: messages.length === 0,
      message: messages.length ? messages.join(" ") : "Ready for the next publishing slot.",
      item: publicItem(item),
      cycleNumber: selection.cycleNumber,
      ...(messages.length ? { nextEligibleAt } : {}),
    };
  }

  private async runTick(reason: "scheduled" | "manual"): Promise<TickResult> {
    const now = Date.now();
    const claimToken = crypto.randomUUID();
    const reservation = await this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      if (!state.enabled) {
        return { state, result: { status: "skipped", message: "Automation is paused." } as TickResult };
      }
      if (state.inFlight) {
        return { state, result: { status: "blocked", message: "An earlier publishing attempt is unresolved; reconcile it rather than retrying and risking a duplicate.", contentId: state.inFlight.contentId, ambiguous: true } as TickResult };
      }
      const slotEligibilityResult = slotEligibility(state.lastAttemptAt, now);
      if (!slotEligibilityResult.eligible) {
        return { state, result: { status: "skipped", message: "The minimum three-hour slot interval has not elapsed.", nextEligibleAt: slotEligibilityResult.nextEligibleAt } as TickResult };
      }
      if (state.items.length === 0) {
        state.lastAttemptAt = now;
        state.lastAction = { at: now, message: "Skipped slot: the content queue is empty." };
        await this.writeState(state, tx);
        return { state, result: { status: "skipped", message: "The content queue is empty." } as TickResult };
      }

      const selection = selectCandidate(state);
      state.cycleNumber = selection.cycleNumber;
      state.cycleSeenIds = selection.cycleSeenIds;
      const item = selection.candidate;
      if (!item) {
        state.lastAttemptAt = now;
        state.lastAction = { at: now, message: "Skipped slot: there is no candidate in the queue." };
        await this.writeState(state, tx);
        return { state, result: { status: "skipped", message: "No candidate in the queue." } as TickResult };
      }
      const repeatEligibilityResult = itemRepeatEligibility(item, now);
      if (!repeatEligibilityResult.eligible) {
        state.lastAttemptAt = now;
        state.lastAction = { at: now, message: `Skipped slot: oldest item #${item.sequence} is inside the 24-hour repeat-protection window.` };
        await this.writeState(state, tx);
        return { state, result: { status: "skipped", message: "The oldest FIFO item is inside the 24-hour repeat-protection window; the slot was skipped.", contentId: item.id, nextEligibleAt: repeatEligibilityResult.nextEligibleAt } as TickResult };
      }

      state.lastAttemptAt = now;
      state.inFlight = { token: claimToken, contentId: item.id, startedAt: now, reason };
      state.lastAction = { at: now, message: `Publishing queue item #${item.sequence} (cycle ${state.cycleNumber}).` };
      await this.writeState(state, tx);
      return { state, item, result: null as TickResult | null };
    });

    if (reservation.result) return reservation.result;
    const item = reservation.item;
    if (!item) return { status: "error", message: "Failed to reserve a queue item." };

    let response: Response;
    try {
      response = await this.publishToFacebook(item);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      if (error instanceof PublishTransportError) {
        await this.keepAmbiguous(claimToken, `Publishing outcome is unknown: ${detail}`);
        return { status: "ambiguous", message: "The network request failed before its outcome could be verified. The queue is locked to prevent a duplicate; check Facebook, then reconcile.", contentId: item.id, ambiguous: true };
      }
      await this.clearFailedReservation(claimToken, detail);
      return { status: "error", message: detail.slice(0, 700), contentId: item.id };
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "response body read failed";
      await this.keepAmbiguous(claimToken, `Facebook response could not be read: ${detail}`);
      return { status: "ambiguous", message: "Facebook responded, but its response body could not be read. Check the Page before reconciling.", contentId: item.id, ambiguous: true };
    }

    let payload: GraphPublishResult;
    try {
      payload = JSON.parse(raw) as GraphPublishResult;
    } catch {
      payload = {};
      if (response.ok) {
        await this.keepAmbiguous(claimToken, "Facebook returned a successful HTTP response with an unreadable response body.");
        return { status: "ambiguous", message: "Facebook may have published this item, but the response could not be verified. Check the Page before reconciling.", contentId: item.id, ambiguous: true };
      }
    }

    if (!response.ok || payload.error) {
      const errorMessage = graphErrorMessage(payload, response.status);
      if (response.status >= 500) {
        await this.keepAmbiguous(claimToken, errorMessage);
        return { status: "ambiguous", message: `${errorMessage}. The outcome may be uncertain; check the Page before reconciling.`, contentId: item.id, ambiguous: true };
      }
      await this.clearFailedReservation(claimToken, errorMessage);
      return { status: "error", message: errorMessage, contentId: item.id };
    }

    const postId = payload.post_id ?? payload.id;
    if (!postId) {
      await this.keepAmbiguous(claimToken, "Facebook accepted the request but returned no recognizable post ID.");
      return { status: "ambiguous", message: "Facebook returned no recognizable post ID. Check the Page before reconciling.", contentId: item.id, ambiguous: true };
    }

    const completed = await this.finishSuccessfulReservation(claimToken, item.id, postId);
    if (!completed) {
      return { status: "ambiguous", message: "The publishing reservation changed while the request was in progress. Verify the Page before taking further action.", contentId: item.id, postId, ambiguous: true };
    }
    return { status: "published", message: "Facebook accepted the post.", contentId: item.id, postId };
  }

  private async publishToFacebook(item: ContentItem): Promise<Response> {
    const pageId = this.env.FACEBOOK_PAGE_ID?.trim();
    const accessToken = this.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim();
    const version = this.env.META_GRAPH_API_VERSION || "v26.0";
    if (!pageId || !/^\d+$/.test(pageId)) throw new Error("FACEBOOK_PAGE_ID is missing or invalid");
    if (!accessToken) throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN is not configured");
    if (!/^v\d+\.\d+$/.test(version)) throw new Error("META_GRAPH_API_VERSION must look like v26.0");

    const hasImage = Boolean(item.imageUrl || item.mediaKey);
    const endpoint = `https://graph.facebook.com/${version}/${pageId}/${hasImage ? "photos" : "feed"}`;
    const form = new FormData();
    form.set("published", "true");
    if (hasImage) {
      if (item.text) form.set("caption", item.text);
      if (item.imageUrl) {
        form.set("url", item.imageUrl);
      } else if (item.mediaKey) {
        const object = await this.env.MEDIA.get(item.mediaKey);
        if (!object) throw new Error("The stored image for this queue item is missing from R2");
        const bytes = await object.arrayBuffer();
        const mimeType = item.mimeType ?? "image/jpeg";
        form.set("source", new Blob([bytes], { type: mimeType }), item.fileName ?? "upload-image");
      }
    } else {
      if (!item.text) throw new Error("Text-only queue item has no text");
      form.set("message", item.text);
    }

    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
        body: form,
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network request failed";
      throw new PublishTransportError(detail.slice(0, 500));
    }
  }

  private async keepAmbiguous(token: string, message: string): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      if (state.inFlight?.token !== token) return;
      state.lastError = message.slice(0, 700);
      state.lastAction = { at: Date.now(), message: "Publishing outcome is ambiguous; the queue is locked until manual reconciliation." };
      await this.writeState(state, tx);
    });
  }

  private async clearFailedReservation(token: string, message: string): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      if (state.inFlight?.token !== token) return;
      state.inFlight = null;
      state.lastError = message.slice(0, 700);
      state.lastAction = { at: Date.now(), message: "Facebook rejected the post. The queue item remains eligible for a later slot." };
      await this.writeState(state, tx);
    });
  }

  private async finishSuccessfulReservation(token: string, itemId: string, postId: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      if (state.inFlight?.token !== token || state.inFlight.contentId !== itemId) return false;
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        state.inFlight = null;
        state.lastError = "A successfully published queue item was removed before state could be finalized.";
        await this.writeState(state, tx);
        return false;
      }
      const now = Date.now();
      item.lastPostedAt = now;
      item.publishedCount += 1;
      if (!state.cycleSeenIds.includes(itemId)) state.cycleSeenIds.push(itemId);
      state.lastPublishedAt = now;
      state.lastPostId = postId;
      state.totalPublished += 1;
      state.inFlight = null;
      state.lastError = null;
      state.lastAction = { at: now, message: `Published queue item #${item.sequence} successfully (cycle ${state.cycleNumber}).` };
      await this.writeState(state, tx);
      return true;
    });
  }

  private async reconcile(request: Request): Promise<Response> {
    const body = requireJsonObject(await request.json());
    const decision = body.decision;
    const postId = typeof body.postId === "string" ? body.postId.trim().slice(0, 200) : "";
    if (decision !== "posted" && decision !== "not_posted") return json({ error: "decision must be 'posted' or 'not_posted'" }, 400);
    if (decision === "posted" && !postId) return json({ error: "postId is required after you verify the post exists" }, 400);

    const result = await this.ctx.storage.transaction(async (tx) => {
      const state = await this.readState(tx);
      const attempt = state.inFlight;
      if (!attempt) return { status: "missing" as const };
      if (Date.now() - attempt.startedAt < RECONCILE_AFTER_MS) {
        return { status: "too_early" as const, retryAt: attempt.startedAt + RECONCILE_AFTER_MS };
      }
      if (decision === "posted") {
        const item = state.items.find((candidate) => candidate.id === attempt.contentId);
        const now = Date.now();
        if (item) {
          item.lastPostedAt = now;
          item.publishedCount += 1;
          if (!state.cycleSeenIds.includes(item.id)) state.cycleSeenIds.push(item.id);
        }
        state.lastPublishedAt = now;
        state.lastPostId = postId;
        state.totalPublished += 1;
        state.lastAction = { at: now, message: `Manually reconciled queue item ${attempt.contentId} as posted.` };
        state.lastError = null;
      } else {
        state.lastAction = { at: Date.now(), message: `Manually reconciled queue item ${attempt.contentId} as not posted; it remains in the queue.` };
        state.lastError = null;
      }
      state.inFlight = null;
      await this.writeState(state, tx);
      return { status: "done" as const };
    });

    if (result.status === "missing") return json({ error: "There is no unresolved publishing attempt" }, 409);
    if (result.status === "too_early") return json({ error: "Wait at least 10 minutes after the attempt before reconciling", retryAt: result.retryAt }, 409);
    return json({ ok: true, message: decision === "posted" ? "Recorded as posted. The item will not be retried in this cycle." : "Recorded as not posted. The item remains in the queue." });
  }
}
