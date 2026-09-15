# Clawtop

A small, self-hosted, **read-only** terminal-style dashboard for live OpenClaw fleet activity. One Node service connects independently to one or more Gateways, merges their safe projections into a Gateway → agent → session tree, and streams it to the browser over SSE.

![Status](https://img.shields.io/badge/status-MVP-74e0a8) ![Node](https://img.shields.io/badge/node-%3E%3D22.19-6bd5df)

## What the MVP shows

- Gateway → agent → session → child-session hierarchy
- Per-Gateway connect/reconnect/error state and server version
- Active, idle, and unknown states without guessing unknown into idle
- Verified runtime and placement facts when projected by the Gateway: agent runtime/harness, model provider, placement state/provider/profile, machine class/OS label, and paired-device runner availability
- Active elapsed time, last-signal age, sanitized progress-card summaries, and safe recent signals
- Demo data for two Gateways with no OpenClaw configuration

Clawtop never calls Gateway write/control methods or activates observer work. Tool arguments, outputs, prompts, progress-card Markdown, credentials, URLs, derived transcript titles, and raw event payloads are not retained in browser state. The browser receives only normalized labels, state, timing, source IDs, Gateway identity, and bounded status/progress fields. Recent signals are process-memory-only and capped at 40 per session.

Unknown runtime and placement fields are omitted rather than inferred. In particular, Clawtop does not treat an absent placement, machine, or runner as local, offline, or unavailable.

## Topology boundary

Clawtop connects only to OpenClaw Gateways. It does not SSH to machines, attach to harness processes, or connect directly to runner hosts. OpenClaw-managed remote placements—including paired-device and cloud-worker placements—remain visible through their owning Gateway's `sessions.list` projection.

An independent Codex, Claude Code, ACP, or other standalone harness that is not represented by an OpenClaw Gateway is outside this MVP. Supporting one later requires a separate read-only adapter that maps its verified facts into Clawtop's normalized model; it should not weaken the Gateway boundary or turn the dashboard into a host-management agent.

## Quick start: demo

Requirements: Node 22.19+ and npm.

```bash
cp .env.example .env
npm ci --include=dev
npm run dev
```

Open <http://localhost:3333>. The default configuration starts demo mode and displays Scruffy/Unraid and Morrow/Lantern as separate Gateway roots.

## Live multi-Gateway setup

The integration uses exact pins of the official `@openclaw/gateway-client` and `@openclaw/gateway-protocol` packages. Each connection requests only `operator.read`.

For Compose, copy `gateways.example.json` to an ignored private file:

```json
[
  {
    "id": "scruffy",
    "name": "Scruffy / Unraid",
    "url": "wss://scruffy.example.ts.net",
    "token": "replace-me"
  },
  {
    "id": "morrow",
    "name": "Morrow / Lantern",
    "url": "wss://lantern.example.ts.net",
    "token": "replace-me"
  }
]
```

Set `CLAWTOP_MODE=live`, `CLAWTOP_HTTP_PASSWORD` to a long random password, and `CLAWTOP_GATEWAYS_FILE=/run/secrets/clawtop-gateways.json`. The committed `docker-compose.yml` bind-mounts the private file from `CLAWTOP_GATEWAYS_PATH`. The HTTP Basic username defaults to `clawtop` and can be changed with `CLAWTOP_HTTP_USERNAME`. `CLAWTOP_GATEWAYS` accepts the same array inline when an environment value is more convenient. Each entry supports:

- `id`, `name`, and `url` (required); keep `id` stable even if the display name or route changes
- either `token` or `password` for initial authentication (never both)
- `fingerprint` when certificate pinning is needed (`tlsFingerprint` remains accepted as a compatibility alias)

Gateway IDs must be unique. They namespace otherwise-colliding agent/session IDs and select the persistent identity directory, so keep them stable.

### Single-Gateway shorthand

A one-Gateway deployment can omit the JSON list:

```dotenv
CLAWTOP_MODE=live
CLAWTOP_HTTP_USERNAME=clawtop
CLAWTOP_HTTP_PASSWORD=replace-with-a-long-random-password
OPENCLAW_GATEWAY_ID=scruffy
OPENCLAW_GATEWAY_NAME=Scruffy / Unraid
OPENCLAW_GATEWAY_URL=wss://gateway.example.ts.net
OPENCLAW_GATEWAY_TOKEN=replace-me
CLAWTOP_DATA_DIR=/data
```

Do not combine the shorthand with a Gateway list.

### Pairing and credential lifecycle

Clawtop creates a separate persistent Ed25519 identity and device-token store for every Gateway under `/data/gateways/<id>`, with owner-only permissions. Approve each first-time device request on its own Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

After a Gateway has connected and saved its narrower paired device token, its shared token/password may be removed from the list. Keep the data volume across upgrades; losing one Gateway directory requires re-pairing only that Gateway.

### Transport and dashboard safety

Live mode protects every HTTP route—including static assets and `/api/health`—with dependency-free HTTP Basic authentication. `CLAWTOP_HTTP_PASSWORD` is required unless the explicit `CLAWTOP_ALLOW_UNAUTHENTICATED=true` break-glass is set. Basic authentication does **not** encrypt traffic: keep the default loopback Compose bind and terminate TLS at an authenticated reverse proxy, use Tailscale Serve/tailnet access, or use a loopback SSH tunnel. Do not expose Clawtop directly on an untrusted network.

Prefer `wss://` for Gateway connections. The official client accepts plaintext only for loopback/private-address cases; do not enable its insecure-private-WS break-glass setting across an untrusted network. Read-only upstream access still exposes session names and activity metadata to authenticated dashboard viewers.

## Docker Compose

```bash
cp .env.example .env
cp gateways.example.json gateways.json
# edit both private files

docker compose pull
docker compose up -d
```

Pushes to `main` publish `ghcr.io/kylejschultz/clawtop:latest`; version tags also publish their semantic version, and every build receives an immutable `sha-<commit>` tag. The Compose file uses host bind mounts—not an anonymous or named Docker volume—so identities and paired tokens remain in `CLAWTOP_DATA_PATH`, while the private Gateway list comes from `CLAWTOP_GATEWAYS_PATH`. It publishes port `3333` on the host by default; keep that host behind a trusted LAN/tailnet and use TLS or an authenticated reverse proxy before exposing it more broadly. The container runs unprivileged, drops capabilities, uses a read-only root filesystem, and writes only to `/data`. Authenticated `/api/health` returns `200` only when every configured Gateway is connected; its body reports each Gateway's state plus aggregate Gateway/agent/session counts without URLs or credentials.

## Unraid: Scruffy plus remote Morrow

Create an authoritative `clawtop` Compose Manager project from the committed `docker-compose.yml`; keep Unraid-only WebUI/icon labels in its local `docker-compose.override.yml`. Use `ghcr.io/kylejschultz/clawtop:latest` and advance it only with an explicit pull and recreate.

1. Copy `.env.example` to the project's private `.env`. Set `CLAWTOP_DATA_PATH=/mnt/user/appdata/clawtop`, `CLAWTOP_GATEWAYS_PATH=/mnt/user/appdata/clawtop/gateways.json`, `CLAWTOP_MODE=live`, and a long `CLAWTOP_HTTP_PASSWORD`.
2. Copy `gateways.example.json` to `/mnt/user/appdata/clawtop/gateways.json` and fill it privately. Make the data directory writable by container UID 1000 and the Gateway file readable by that UID; the JSON is mounted read-only.
3. Configure Scruffy as one Gateway entry using its private host route.
4. Expose Lantern/Morrow to Unraid through a secure `wss://` tailnet route (recommended), then add it as the second entry. Do not expose Lantern's Gateway broadly or send credentials over plaintext between hosts.
5. Start Clawtop and approve its device separately on Scruffy and Morrow.
6. Remove shared bootstrap credentials after paired device tokens are saved, then verify both Gateway roots show connected.
7. Expose port `3333` only on a trusted interface or through TLS on a trusted tailnet/authenticated reverse proxy.

No dynamic configuration UI is included; Gateway membership is intentionally deployment configuration.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

- `src/config.ts` validates list/file/shorthand configuration.
- `src/adapters.ts` owns one official client and credential boundary per Gateway.
- `src/model.ts` namespaces and merges Gateway snapshots/events in a pure reducer.
- `src/server.ts` serves static assets, `/api/state`, `/api/health`, and `/api/events`.
- `src/web/client.ts` renders the dependency-free accessible fleet tree.

## Verified contract and deliberate limits

Verified against OpenClaw package `2026.9.4` declarations/runtime and matching protocol docs:

- `GatewayClient` supports challenge-authenticated Node connections, reconnects, requests, events, and host-owned identity/token persistence.
- The exact Gateway RPC allowlist is `agents.list`, `sessions.subscribe`, `sessions.list`, `sessions.messages.subscribe`, `sessions.messages.unsubscribe`, and `progressCard.get`. The message subscriptions never request approval events; Clawtop does not call `sessions.observer.visibility`.
- Clawtop reconciles exact-session message subscriptions only for the merged sessions displayed in each snapshot, resets them across reconnects, and performs a trailing `sessions.list` when `sessions.changed` races the bootstrap response.
- Session-list requests do not enable derived transcript titles. Titles come only from explicit `label`, `displayName`, or `autoLabel` fields, then fall back to the session key.
- Event/progress history survives a snapshot only when the Gateway supplies the same stable `sessionId`; missing or changed IDs reset lifecycle state so reused session keys cannot inherit stale activity.
- `agents.list` supplies configured `agentRuntime` metadata. `sessions.list` supplies effective per-session runtime/model-provider facts and, when enabled, the closed placement projection including provider/profile, machine, and device-runner status.
- The safe browser projection intentionally drops placement workspace paths, environment IDs, bundle/manifests, ACK cursors, command requirements, progress-card Markdown, and other control-plane internals. A progress card contributes only revision/time, completed/total counts, and one bounded current-or-next step.
- `hasActiveRun` / `activeRunIds` are documented but absent from the published `SessionRow` declaration; Clawtop isolates that additive mismatch in `SessionWire` and treats absence as **unknown**.
- Clawtop merges every active session (retrieved with paginated `activeOnly` reads) with one recent-history page of up to 200 sessions per Gateway. Active pages follow `hasMore`/`nextOffset`; missing or non-advancing pagination metadata fails the refresh visibly instead of publishing an incomplete active set. When Gateway totals make it detectable, the UI reports how many inactive sessions are shown and hidden. The 200-row bound applies only to recent history: Clawtop imposes no active-session or concurrent-run cap, and any Gateway/runtime concurrency limit is separate.
- SSE clients default to a maximum of 32 (`CLAWTOP_MAX_SSE_CLIENTS`); excess connections receive `503`. Slow clients retain only the latest pending state and flush it after backpressure clears.
- Event summaries are in memory only; there are no transcript, tool-output, cost, approval, control, durable-storage, or dynamic-config surfaces.

Live multi-Gateway integration has **not** been tested against the real Morrow and Scruffy Gateways; it still requires their routes, credentials, and pairing approval. Demo mode, configuration parsing, cross-Gateway namespace isolation, connection recovery, per-Gateway identity storage, reducer behavior, production build, and HTTP/SSE serving are locally testable.
