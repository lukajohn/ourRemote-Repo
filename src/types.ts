export interface Env {
  STATE: DurableObjectNamespace;
  MEDIA: R2Bucket;
  ADMIN_SECRET?: string;
  FACEBOOK_PAGE_ID?: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  META_GRAPH_API_VERSION?: string;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T>;
}

export interface DurableObjectTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DurableObjectState {
  storage: DurableObjectStorageLike;
}

export interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

export interface ContentItem {
  id: string;
  sequence: number;
  text: string;
  imageUrl?: string;
  mediaKey?: string;
  fileName?: string;
  mimeType?: string;
  fingerprint: string;
  createdAt: number;
  lastPostedAt: number | null;
  publishedCount: number;
}

export interface InFlightPost {
  token: string;
  contentId: string;
  startedAt: number;
  reason: "scheduled" | "manual";
}

export interface ActionRecord {
  at: number;
  message: string;
}

export interface StoreState {
  schemaVersion: 1;
  enabled: boolean;
  items: ContentItem[];
  nextSequence: number;
  cycleNumber: number;
  cycleSeenIds: string[];
  lastAttemptAt: number | null;
  lastPublishedAt: number | null;
  lastPostId: string | null;
  totalPublished: number;
  inFlight: InFlightPost | null;
  lastError: string | null;
  lastAction: ActionRecord | null;
}

export interface PreparedItem {
  text: string;
  imageUrl?: string;
  mediaKey?: string;
  fileName?: string;
  mimeType?: string;
  fingerprint: string;
}

export interface GraphPublishResult {
  id?: string;
  post_id?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}
