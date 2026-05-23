# OpenClaw on Replit

A self-hosted OpenClaw AI assistant running on Replit — chat via the web UI or Telegram.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080), which also starts the OpenClaw gateway (port 18789)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required secrets: `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`
- Optional secret: `OPENCLAW_GATEWAY_TOKEN` — internal auth token for the gateway; auto-generated at runtime if not provided

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- AI: OpenClaw gateway (v2026.5.x) + OpenAI gpt-4o
- Channels: Telegram (via OpenClaw gateway)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/lib/openclaw-gateway.ts` — OpenClaw gateway lifecycle (spawn, config, shutdown)
- `artifacts/api-server/src/routes/openclaw.ts` — `/api/openclaw/health` and `/api/openclaw/chat` routes
- `artifacts/api-server/dist/openclaw-runtime.json` — generated at runtime from env vars; written to `dist/` (gitignored) so secrets never enter version control
- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `artifacts/chat-ui/` — web chat frontend (React + Vite, preview path `/chat-ui/`)

## Architecture decisions

- OpenClaw gateway runs as a child process spawned by Express on startup; graceful SIGTERM on shutdown
- Gateway config (`artifacts/api-server/dist/openclaw-runtime.json`) is written at startup from env vars — the `dist/` directory is gitignored so secrets never enter version control
- `OPENCLAW_CONFIG_PATH` env var points the gateway to this runtime config file at startup
- Chat endpoint (`/api/openclaw/chat`) proxies requests through the OpenClaw gateway's `/v1/chat/completions` endpoint — all AI turns go through the gateway so Telegram and web chat share the same agent session, memory, and routing config
- OpenClaw gateway handles Telegram channel natively
- Gateway auth uses a token passed via `OPENCLAW_GATEWAY_TOKEN` env var; if not set, a random UUID is generated for the process lifetime (safe because port 18789 is internal-only)
- `openclaw` v2026.5.20 enables the `/v1/chat/completions` HTTP endpoint via `gateway.http.endpoints.chatCompletions.enabled: true`

## Product

- Web chat UI at `/chat-ui/` — chat with the AI in the browser
- Telegram bot — message the bot on Telegram and it replies via OpenClaw

## User preferences

- AI model: OpenAI (gpt-4o)
- Channels: Telegram
- Interface: simple web chat + Telegram

## Gotchas

- The `openclaw` binary is resolved by finding the package root from `require.resolve("openclaw")` then appending `openclaw.mjs` — the subpath `./openclaw.mjs` is not in the package `exports` field, only in `bin`
- Gateway bind mode is `lan` (not loopback) so Replit's proxy can reach port 18789
- `openclaw` and `openai` are in the esbuild `external` list — they must not be bundled
- `openclaw@2026.5.20` is temporarily in `minimumReleaseAgeExclude` (pnpm-workspace.yaml) — remove once the 24-hour window passes
- The openclaw package version is `2026.5.x` — update the fallback path in `resolveOpenclawMjs()` if upgraded
