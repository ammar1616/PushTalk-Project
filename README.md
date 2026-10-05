# PushTalk

A walkie-talkie-style web app. Signed-in users join channels and exchange short
voice clips. Clips arrive live over a WebSocket, play one at a time in the order
they were sent, and never play back to the person who sent them.

Built to the assignment brief in `SPEC.md`.

---

## Quick start

Requires Docker Desktop (or Docker Engine + Compose v2). Nothing else — the
backend and frontend both run in containers.

```bash
cp .env.example .env
docker compose up --build
```

Then open **http://localhost:5173** in two different browsers (or one normal and
one private window), sign up as two different users, have one create a channel,
and have the other join it by name. Hold to record; release to send.

The first clip you try to play shows a **"Tap to enable audio"** overlay. That is
the browser's autoplay policy, not a bug — see
[DECISIONS.md](./DECISIONS.md#3-autoplay-unlock).

### Services

| Service  | Port | What it is |
|----------|------|------------|
| frontend | 5173 | Vite dev server serving the React SPA |
| backend  | 8000 | FastAPI app (REST + WebSocket), OpenAPI at `/docs` |
| worker   | —    | `arq` worker; runs ffmpeg to normalize uploads |
| db       | 5432 | PostgreSQL 16 |
| redis    | 6379 | job queue (arq) and pub/sub fan-out |

### Common commands

```bash
# backend test suite (runs inside the container; no host Python needed)
docker compose exec -T -w /app backend python -m pytest

# frontend checks (run on the host; needs Node 20+)
cd frontend
npm install          # first time only
npm run typecheck
npm test
npm run build
```

---

## Architecture

```
                         ┌──────────────────────────┐
        browser          │        FastAPI            │
   ┌───────────────┐     │   (uvicorn :8000)         │        ┌────────────┐
   │  React SPA    │◄───►│                           │◄──────►│ PostgreSQL │
   │  (Vite :5173) │ HTTP│  REST: auth, channels,    │  SQL   │   :5432    │
   │               │  WS │        messages, media    │        └────────────┘
   │  ─ AuthContext│     │  WS: /ws (per channel)    │
   │  ─ PlaybackQueue    │                           │        ┌────────────┐
   │  ─ useWebSocket│    │  subscribes: pushtalk:     │◄──────►│   Redis    │
   └───────┬───────┘     │             channel:*     │ pub/sub│   :6379    │
           │             └────────────┬──────────────┘        │  + arq job │
           │                          │ enqueue job           │    queue   │
           │ upload                   ▼                       └─────┬──────┘
           │ (multipart)        ┌──────────────┐   ffmpeg          │
           └───────────────────►│  arq worker  │───────────────────┘
                                │  :no port    │   normalize → opus/ogg,
                                └──────┬───────┘   probe duration, 64 peaks
                                       │
                                       ▼
                                 /media  (Docker volume)
                                  original/  normalized/
```

### How a clip travels

1. The browser records with `MediaRecorder` and `POST`s the blob to
   `/channels/{id}/messages` (multipart).
2. The backend streams it to disk, checks the real duration with `ffprobe`
   (rejecting < 0.5 s or > 60 s), writes a `pending` row, and enqueues an arq
   job. It answers `202` immediately.
3. The worker transcodes to mono 48 kHz Opus/OGG, measures duration again,
   computes 64 waveform peaks, marks the row `ready`, and publishes
   `message.new` to `pushtalk:channel:{id}`.
4. Every API process subscribed to `pushtalk:channel:*` fans that event out to
   the WebSockets watching that channel.
5. The receiving browser enqueues the clip into `PlaybackQueue`, marks it
   `delivered` on arrival and `played` when it finishes, and the server
   broadcasts `message.status` so the sender's button advances.

---

## Project layout

```
backend/
  app/
    api/          auth, channels, messages, media, ws (FastAPI routers)
    core/         config, security (JWT), errors, logging, queue
    db/           SQLAlchemy models and async session
    realtime/     ConnectionManager + Redis pub/sub listener
    schemas/      Pydantic request/response models
    services/     auth, channel, message, audio (ffmpeg/ffprobe)
    worker/       arq settings and the processing task
  alembic/        migrations
  tests/          pytest suite
frontend/
  src/
    api/          fetch client + types
    auth/         AuthContext and useAuth
    components/   recorder button, message list/bubble, waveform, overlay
    pages/        login, channels, channel
    playback/     PlaybackQueue (pure) + usePlaybackQueue
    realtime/     socket event reducer + useWebSocket
    recorder/     useRecorder (MediaRecorder wrapper)
```

---

## API

All errors share one shape:

```json
{ "error": { "code": "AUDIO_REJECTED", "message": "...", "details": null } }
```

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/auth/signup` | — | returns a JWT |
| POST | `/auth/login` | — | returns a JWT |
| GET | `/auth/me` | Bearer | current user |
| POST | `/channels` | Bearer | create |
| GET | `/channels` | Bearer | list |
| POST | `/channels/{id}/join` | Bearer | join by id |
| GET | `/channels/{id}/members` | Bearer | includes `online` |
| POST | `/channels/{id}/messages` | Bearer | multipart upload, `202` |
| GET | `/channels/{id}/messages` | Bearer | keyset pagination |
| GET | `/messages/{id}` | Bearer | single message + status |
| POST | `/messages/{id}/delivered` | Bearer | mark delivered |
| POST | `/messages/{id}/played` | Bearer | mark played |
| GET | `/media/{id}` | Bearer or `?token=` | streams the clip, members only |
| WS  | `/ws?token=&channel_id=&since_sequence=` | query token | live + catch-up |

`GET /docs` serves the generated OpenAPI UI.

---

## Known limitations

These are deliberate cuts or known gaps, written down rather than hidden. The
full reasoning is in [DECISIONS.md](./DECISIONS.md).

- **WebSocket protocol differs from `SPEC.md`.** The brief describes a
  `subscribe` frame and a `presence` event; the backend reads `channel_id` and
  `since_sequence` from the query string and derives presence from the members
  endpoint instead. The frontend follows the code, not the brief.
  (SPEC §7/§9.)
- **Presence is a snapshot, not live.** The member list (and its `online` flags)
  is fetched once when the channel page opens. A user joining or leaving after
  that is not reflected until the page is reloaded. The server-side state is
  correct; only the UI refresh is missing.
- **Catch-up is capped at the last 200 messages** (`REPLAY_LIMIT`) so a client
  that has been away for days does not receive an unbounded backlog.
- **The recording ceiling is 60 s wall-clock**, enforced by the recorder, and
  re-checked server-side by `ffprobe`. A client that ignores the UI cap still
  gets rejected.
- **A sender can mark their own message `delivered`/`played`** through the API.
  The UI never does it, so it has no visible effect, but the endpoint does not
  refuse it. Noted as a fix in `DECISIONS.md`.
- **`GET /media/{id}` distinguishes "not found" (404) from "not a member"
  (403)**, which slightly leaks whether a message id exists. A stranger can
  create no such id, and can learn nothing about its contents.
- **Validation errors echo the submitted field values**, including the password
  on a signup/login validation failure. The payload returns only to the sender,
  but could be captured by an upstream error tracker. Fix noted in
  `DECISIONS.md`.
- **No HTTPS/TLS, no refresh-token rotation, `JWT_SECRET` defaults to
  `change-me-in-prod`.** Fine for local review, not for a real deployment.
- **Single-process presence.** The `ConnectionManager` lives in one API process;
  `docker compose` runs one. Horizontal scaling would need Redis-backed presence
  (the pub/sub fan-out is already Redis-based).
- **No direct messages, no transcription, no rate limiting, no S3.** Explicit
  non-goals from the brief (SPEC §15).
