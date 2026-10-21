import type { ContentItem, StoreState } from "./types.ts";

export const MIN_SLOT_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const MIN_ITEM_REPEAT_GAP_MS = 24 * 60 * 60 * 1000;
export const MAX_QUEUE_ITEMS = 500;
export const MAX_TEXT_LENGTH = 5_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const RECONCILE_AFTER_MS = 10 * 60 * 1000;

export function initialState(): StoreState {
  return {
    schemaVersion: 1,
    enabled: false,
    items: [],
    nextSequence: 1,
    cycleNumber: 1,
    cycleSeenIds: [],
    lastAttemptAt: null,
    lastPublishedAt: null,
    lastPostId: null,
    totalPublished: 0,
    inFlight: null,
    lastError: null,
    lastAction: null,
  };
}

export function normalizeState(value: unknown): StoreState {
  const base = initialState();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<StoreState>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const highestSequence = items.reduce((highest, item) => {
    return Number.isSafeInteger(item?.sequence) ? Math.max(highest, item.sequence) : highest;
  }, 0);
  return {
    ...base,
    ...raw,
    schemaVersion: 1,
    enabled: raw.enabled === true,
    items,
    nextSequence: Number.isSafeInteger(raw.nextSequence) && Number(raw.nextSequence) > highestSequence
      ? Number(raw.nextSequence)
      : highestSequence + 1,
    cycleNumber: Number.isSafeInteger(raw.cycleNumber) && Number(raw.cycleNumber) > 0
      ? Number(raw.cycleNumber)
      : 1,
    cycleSeenIds: Array.isArray(raw.cycleSeenIds) ? raw.cycleSeenIds.filter((id): id is string => typeof id === "string") : [],
    lastAttemptAt: typeof raw.lastAttemptAt === "number" ? raw.lastAttemptAt : null,
    lastPublishedAt: typeof raw.lastPublishedAt === "number" ? raw.lastPublishedAt : null,
    lastPostId: typeof raw.lastPostId === "string" ? raw.lastPostId : null,
    totalPublished: Number.isSafeInteger(raw.totalPublished) && Number(raw.totalPublished) >= 0 ? Number(raw.totalPublished) : 0,
    inFlight: raw.inFlight && typeof raw.inFlight.token === "string" ? raw.inFlight : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    lastAction: raw.lastAction && typeof raw.lastAction.at === "number" && typeof raw.lastAction.message === "string"
      ? raw.lastAction
      : null,
  };
}

export function slotEligibility(lastAttemptAt: number | null, now: number): { eligible: boolean; nextEligibleAt?: number } {
  if (lastAttemptAt === null || now - lastAttemptAt >= MIN_SLOT_INTERVAL_MS) return { eligible: true };
  return { eligible: false, nextEligibleAt: lastAttemptAt + MIN_SLOT_INTERVAL_MS };
}

export function itemRepeatEligibility(item: ContentItem, now: number): { eligible: boolean; nextEligibleAt?: number } {
  if (item.lastPostedAt === null || now - item.lastPostedAt >= MIN_ITEM_REPEAT_GAP_MS) return { eligible: true };
  return { eligible: false, nextEligibleAt: item.lastPostedAt + MIN_ITEM_REPEAT_GAP_MS };
}

export interface CandidateSelection {
  candidate: ContentItem | null;
  cycleNumber: number;
  cycleSeenIds: string[];
  didResetCycle: boolean;
}

/** FIFO selection. A new content item joins the current cycle at the newest end. */
export function selectCandidate(state: StoreState): CandidateSelection {
  const items = [...state.items].sort((a, b) => a.sequence - b.sequence);
  const existingIds = new Set(items.map((item) => item.id));
  let cycleSeenIds = state.cycleSeenIds.filter((id) => existingIds.has(id));
  let cycleNumber = state.cycleNumber;
  let didResetCycle = false;

  if (items.length > 0 && items.every((item) => cycleSeenIds.includes(item.id))) {
    cycleSeenIds = [];
    cycleNumber += 1;
    didResetCycle = true;
  }

  const candidate = items.find((item) => !cycleSeenIds.includes(item.id)) ?? null;
  return { candidate, cycleNumber, cycleSeenIds, didResetCycle };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintContent(text: string, imageIdentity = ""): Promise<string> {
  const normalizedText = text.trim().replace(/\r\n/g, "\n");
  return sha256Hex(new TextEncoder().encode(normalizedText + "\u0000" + imageIdentity));
}

export function normalizeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("text must be a string");
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length > MAX_TEXT_LENGTH) throw new Error(`text must be ${MAX_TEXT_LENGTH} characters or fewer`);
  return normalized;
}

export function normalizePublicImageUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("imageUrl must be a string");
  if (value.length > 2_048) throw new Error("imageUrl is too long");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("imageUrl must be a valid public HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("imageUrl must use HTTPS and must not contain a username or password");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("imageUrl must be publicly accessible, not a local hostname");
  }
  // Reject literal IP addresses rather than risk handing Meta a private or link-local target.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) {
    throw new Error("Use a public hostname rather than an IP address for imageUrl");
  }
  url.hash = "";
  return url.toString();
}

export function publicItem(item: ContentItem) {
  return {
    id: item.id,
    sequence: item.sequence,
    text: item.text,
    imageUrl: item.imageUrl,
    hasImage: Boolean(item.imageUrl || item.mediaKey),
    imageSource: item.mediaKey ? "uploaded" : item.imageUrl ? "url" : "none",
    createdAt: item.createdAt,
    lastPostedAt: item.lastPostedAt,
    publishedCount: item.publishedCount,
  };
}
