# Facebook Page Rotator

TypeScript Cloudflare Worker for scheduled publishing to a **Facebook Page** through Meta's Graph API. It serves a small admin page at the Worker root.

## Features

- Eight scheduler slots per day (every three hours, UTC).
- Persistent FIFO queue in a SQLite-backed Durable Object.
- Publishes the oldest unseen item first; new items are appended to the end of the current cycle.
- 24-hour minimum repeat interval per content item. If the oldest item is too recent, that slot is skipped rather than jumping forward or repeating it.
- Text-only posts, public HTTPS image URLs, and JPEG/PNG uploads up to 8 MiB saved in private Cloudflare R2.
- Exact duplicate detection, pause/resume, preview, queue removal, manual slot trigger, and failure reconciliation.
- Starts paused and empty. Nothing publishes until you add content and enable automation.
- Bearer-secret-protected API; Facebook credentials are Cloudflare secrets, never committed to GitHub.

**Scope:** Facebook Pages only, not personal profiles or groups. Eight schedule slots do not guarantee eight posts: cooldowns may skip slots when the queue is small.

## Requirements

- Node.js 22+ and npm.
- Cloudflare account with Workers, Durable Objects, and R2.
- A Facebook Page you administer.
- Meta developer app and a Page access token with the current publishing permission(s), typically `pages_manage_posts`. Meta may change supported API versions and app-review requirements; verify them in your app dashboard.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create facebook-page-rotator-media

npx wrangler secret put ADMIN_SECRET
npx wrangler secret put FACEBOOK_PAGE_ID
npx wrangler secret put FACEBOOK_PAGE_ACCESS_TOKEN

npm run typecheck
npm test
npx wrangler deploy
```

When Wrangler prompts, supply each secret directly to the terminal. Use a long random admin secret (32+ characters), the numeric Page ID, and a Page access token. **Never paste a token or password into chat, the repository, or source files.** If the R2 bucket already exists in your account, change its name in `wrangler.toml` to a bucket you own.

The current Graph API version is configured in `wrangler.toml` as `v26.0`; check Meta's live version schedule before going to production. Cloudflare Cron Triggers use UTC, not Egypt local time.

After deployment, open the Workers URL printed by Wrangler and enter `ADMIN_SECRET` in the admin page. Add content and enable automation only after checking the configured Page and token. All `/api/*` endpoints require `Authorization: Bearer <ADMIN_SECRET>`.

## Adding posts

Use the admin page to add text, upload a JPEG/PNG image, or paste a public HTTPS image URL. A caption is optional for image-only posts. For API use, send JSON:

```sh
export WORKER_URL="https://facebook-page-rotator.<your-subdomain>.workers.dev"
export ADMIN_SECRET="<your-admin-secret>"

curl -sS -X POST "$WORKER_URL/api/content" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" --data '{"text":"Your post text here"}'

curl -sS "$WORKER_URL/api/status" -H "Authorization: Bearer $ADMIN_SECRET"
curl -sS -X POST "$WORKER_URL/api/resume" -H "Authorization: Bearer $ADMIN_SECRET"
curl -sS -X POST "$WORKER_URL/api/pause" -H "Authorization: Bearer $ADMIN_SECRET"
```

## Safety behaviour

1. Each active cycle traverses queue items oldest to newest. New content joins at the newest end.
2. Exact duplicates already queued are rejected.
3. A content item is not repeated until at least 24 hours after its last successful post.
4. If a publishing request times out or Facebook's response is ambiguous, the queue is locked instead of automatically retrying and potentially creating a duplicate. Check the Page; after the safety window, reconcile the outcome in the admin page.
5. Failed non-ambiguous requests remain eligible for a later slot, subject to the three-hour schedule interval.

The admin interface includes a queue preview, status panel, pause/resume controls, one-slot manual trigger, deletion, and reconciliation after an ambiguous outcome. Uploaded images use a private R2 bucket and are sent to the Page via Graph API.

## Troubleshooting

- `401 Unauthorized`: enter the right admin secret.
- Facebook permission error: verify Page assignment, granted scopes, app mode, and current Meta publishing permissions.
- Image fetch error: use a public HTTPS image URL that Facebook can fetch without login or cookies, or upload the image.
- Queue blocked by unresolved attempt: check Facebook before manually reconciling.
- Logs: `npx wrangler tail`.

## Development

```sh
npm run typecheck
npm test
npm run dev
```

Tests cover FIFO ordering, queue cycling, duplicate detection, the cooldowns, publishing success, and ambiguous network outcomes. Node 22 may print an experimental warning for its built-in TypeScript stripping used in tests.

**Security:** this project does not use your Facebook password. Manage only Pages you are authorized to publish to, and only content you have rights to post.
