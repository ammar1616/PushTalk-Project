# Decisions

Why PushTalk is built the way it is. Each item says what the choice was, what
the alternative was, and why the alternative lost. Items marked **[deviation]**
are places where the running code does not match `SPEC.md`; the code wins and
the difference is recorded here.

---

## The open questions

### 1. Upload transport

**Choice: a direct multipart `POST` from the browser to the API, with the
recording normalized by a background worker.**

The browser sends the raw `MediaRecorder` blob as `multipart/form-data`. The API
saves it, checks the real duration with `ffprobe`, writes a `pending` row, hands
an id to an `arq` job, and returns `202` with the pending message. The worker
does the expensive `ffmpeg` work (transcode to mono 48 kHz Opus/OGG, probe
duration, compute 64 waveform peaks) and only then publishes `message.new`.

Alternatives considered:

- **Base64 the audio inside JSON.** Rejected: ~33% larger payloads, and the
  whole clip has to be buffered and decoded in memory on both ends before a byte
  is stored.
- **Presigned direct-to-S3 upload.** Not available — object storage is a listed
  non-goal (SPEC §15), and it would add a second auth surface for no benefit at
  this scale.
- **Process ffmpeg inside the request.** Rejected: a transcode takes hundreds of
  milliseconds to seconds and would occupy a worker for the whole request. Doing
  it asynchronously also means one slow or malformed clip cannot stall uploads
  for everyone else.

The cost of the async choice is a brief `pending` state and a second status
transition. The UI covers that by showing the message immediately and updating
its status when the worker publishes, rather than pretending the clip is ready.

The size cap is enforced **while streaming** to disk (64 KiB chunks), so an
oversized upload costs one partial file, not the whole body in RAM. The declared
`Content-Type` is used only as a cheap early `415`; the real gate is `ffprobe`
reading the actual bytes.

### 2. Recording start vs. arrival in the transcript

**Choice: a clip is inserted by its server-assigned `sequence`, newest-first,
not by when it arrives on the client.**

Every message gets a per-channel `sequence` from
`next_sequence()`, which takes a `SELECT … FOR UPDATE` lock on the channel row so
two concurrent uploads cannot reserve the same number. The unique constraint on
`(channel_id, sequence)` is the real guarantee; the lock just turns a duplicate-key
error into a short wait.

The client's reducer inserts and re-sorts by `sequence`. This matters because a
clip can arrive over the socket slightly out of order (a reconnect replay, or two
senders racing), and `created_at` is not unique — two uploads in the same
millisecond can share a timestamp. When in doubt, `sequence` is the truth.

Alternatives considered:

- **Append on arrival.** Simplest, but a slow upload or a reconnect would place
  an older clip above a newer one, which looks like data loss to the user.
- **Sort by `created_at`.** Rejected for the tie problem above. `sequence`
  breaks ties deterministically.

### 3. Autoplay unlock

**Choice: one "Tap to enable audio" overlay that plays a silent buffer on first
click, reusing the same `HTMLAudioElement` the queue uses.**

Browsers block `audio.play()` until a user gesture. The app cannot know in
advance whether playback will be blocked, so `AudioUnlockOverlay` sits on top
until the user taps. That tap plays a tiny silent WAV through the *same* audio
element the playback queue will use, which unlocks that element for the rest of
the session. If the browser still refuses, the overlay stays up rather than
silently swallowing clips.

Alternatives considered:

- **Attempt playback and show the overlay only when it throws.** This is more
  polite (no overlay for users who already interacted), but it means the very
  first clip is dropped and has to be retried, and the failure is timing-
  dependent. An explicit unlock is predictable.
- **Assume the record gesture counts as the user gesture.** It often does not:
  the gesture that unlocks audio must be close in time to the `play()` call, and
  recording happens well before the first clip arrives.

### 4. Multiple tabs (multi-tab)

**Choice: the server tracks a `set[WebSocket]` per user; a user is online while
any tab is open, and a status row is per user, not per socket.**

`ConnectionManager` keeps two maps: `by_channel` (who gets this event) and
`by_user` (is this user online). A user with two tabs stays online until the
*last* socket closes. `message_statuses` has a unique `(message_id, user_id)`
constraint, so a `played` from one tab marks the message played for the user, not
"played once per device" — the brief asks for per-user tracking.

A repeated status write never moves a row backwards: `played` outranks
`delivered`, and a `/delivered` that arrives after `/played` (easy from two
tabs, or from a slow first tab) is ignored rather than undoing the stronger
state.

Alternatives considered:

- **Track status per socket.** Rejected: it would double-count a user with two
  tabs and make the sender's "played by N" wrong.
- **Kick older sockets on reconnect.** Rejected: it would surprise a user who
  legitimately has the channel open in two windows, and buys nothing.

### 5. Ordering after reconnect

**Choice: reconnect the socket with the highest `sequence` already held; the
server replays everything above it, oldest-first, and the client merges by
`sequence`.**

The `useWebSocket` hook keeps the last seen sequence in a ref. On reconnect it
opens `/ws?...&since_sequence=<n>`. The server sends `message.replay` events for
every message with `sequence > n` (capped at 200), *before* going live. Replay
is done before the live loop on purpose: the other order lets a message arrive
live and then again in the replay, and the client renders it twice.

The client reducer handles the two awkward cases directly, and both are unit-
tested: a replayed message that is already present updates instead of
duplicating, and a replay batch arriving oldest-first still ends up newest-first.

Alternatives considered:

- **Refetch the whole history page after reconnect.** Simpler, but it re-downloads
  and re-parses clips the client already has, and the cursor logic is exactly the
  pagination problem below. The socket replay is cheaper and already ordered.
- **Subscribe frame carrying `since_sequence`.** This is what SPEC §9 describes,
  but the backend reads `since_sequence` from the query string and has no
  subscribe handler **[deviation]**. The hook follows the backend.

---

## Correctness details that were not asked about but needed a decision

### Keyset pagination over offset

`GET /channels/{id}/messages` pages with a `(created_at, sequence)` cursor, not
`OFFSET`. Offset pagination gets slower the deeper you go and, worse, rows
inserted while a client is paging shift the window and cause duplicates or
skips. Postgres compares the tuple natively, so it is still one condition. A
plain `created_at` cursor is also supported (and is what the brief's signature
suggests) but it cannot distinguish two messages that share a timestamp —
verified by setting every message in a channel to the same `created_at`: the
plain cursor repeats the same page forever, the pair cursor returns all of them
exactly once.

### Per-user status is stored, aggregated on read

`message_statuses` stores one row per `(message_id, user_id)`. `aggregate()`
folds counts into the single `sent → delivered → played` value the sender's
button shows. A channel with no other members is treated as `delivered`, because
nobody is going to confirm it and leaving it on `sent` forever looks broken. The
worker publishes only after processing, so the client never sees a clip whose
file does not exist yet.

### One normalization format

Everything is transcoded to mono 48 kHz Opus in OGG. Chrome records webm/opus,
Firefox only offers Ogg; normalizing server-side means the player, the waveform
extractor, and the media endpoint only ever deal with one codec, instead of
branching on the browser that uploaded.

---

## Where the implementation diverges from SPEC.md

1. **[deviation] No `subscribe` frame.** SPEC §9 says the client sends
   `{ "type": "subscribe", "channel_id", "since_sequence" }`. The backend reads
   `channel_id` and `since_sequence` from the connection query string and only
   handles a `ping` frame. Catch-up is done by reconnecting with an updated
   `since_sequence`. Implementing the frame client-side would be dead code
   against this server.

2. **[deviation] No `presence` WebSocket event.** SPEC §7 lists one. The backend
   never broadcasts presence; online state comes from
   `GET /channels/{id}/members`, whose `online` flag is derived from the
   connection manager. The channel page fetches that roster once on load — so
   presence is currently a snapshot, not a live-updating list. The server-side
   state is correct; the UI does not re-fetch it.

3. **[deviation] An extra `message.replay` event.** SPEC §7 does not list it, but
   the catch-up path needs to distinguish "here is a message you missed" from
   "here is a message happening now". The client treats both as message data.

4. **[deviation] `POST /auth/signup` returns `200`, not `201`.** The spec's REST
   conventions would suggest `201`; the handler does not set a status code, so
   FastAPI's `200` default applies. `POST /channels` does return `201` and
   `POST /channels/{id}/join` returns `204`.

---

## Known limitations and fixes not yet applied

These are real, understood, and deliberately not fixed in a frontend or docs
commit. Each belongs in its own small `fix(backend)` change so the history stays
readable.

1. **Validation errors echo secret input.** `handle_validation_error` in
   `backend/app/main.py` returns `exc.errors()`, whose `fields[].input` includes
   the submitted values — including the password on a failed signup/login
   validation. It returns only to the sender and is not a disclosure, but it can
   land in proxy or error-tracking logs. **Fix:** strip `input` for secret fields
   (or for all fields; the client already knows what it sent).

2. **A sender can mark their own message delivered/played.**
   `POST /messages/{id}/delivered` and `/played` do not refuse the sender.
   Visible impact is nil (the UI never sends it, and a sender who is a channel
   member is counted in `recipient_count`, then subtracted out), but it should
   be rejected or ignored.

3. **`GET /media/{id}` leaks existence via status code.** The route loads the
   message first (`404` if missing) and only then checks membership (`403`),
   even though its own docstring claims the opposite order. A stranger can
   distinguish "no such message" from "exists but you're not in the channel".
   **Fix:** check membership against the channel before revealing 404, or return
   `404` for both. Nothing about the audio's contents leaks either way.

4. **Stale comment on `MemberOut.online`.** `backend/app/schemas/channel.py`
   says "Always False until the realtime layer lands in commit 7." Realtime has
   landed and the flag is computed; the comment is simply out of date.

5. **`recipient_count()` docstring is wrong.** It says "The sender is excluded",
   but the query counts every membership including the sender, and each caller
   subtracts one (`… - 1`). The behaviour is correct; the docstring is not.

6. **Replayed message payloads carry zero counts and no username.** The server's
   `message_payload()` sends `delivered_count: 0`, `played_count: 0`,
   `aggregated_status: "sent"`, and no `sender_username`, because the replay path
   has no per-recipient data cheaply at hand. The client compensates: it keeps
   the counts it already has when a partial payload arrives, and fills missing
   usernames from the member roster. Guessing counts server-side would be worse —
   it would show a sender "sent" for a clip everyone already played.

7. **Security follow-ups.** `python-jose==3.3.0` is pinned in the backend
   requirements and should be reviewed against current advisories; the frontend
   dependency tree reported 3 moderate, 1 high, and 1 critical advisory at build
   time and deserves a `npm audit` pass.

---

## What I cut and why

These are the brief's explicit non-goals (SPEC §15). None are stubbed; they are
absent.

- **Transcription** — a second model/API dependency and a job pipeline of its
  own; not part of the product's core loop.
- **Direct messages** — the data model is channel-based. DMs would need a second
  recipient concept and a second authorization path for little extra value here.
- **Playback speed control** — the waveform player would need rate handling and
  the queue would need to reason about it. Nice-to-have, not core.
- **Per-user rate limiting** — handled implicitly by the upload size and
  duration caps; a real limiter belongs at the edge, not in this app.
- **S3 / MinIO** — local Docker volume (`/media`) is enough to demonstrate the
  protected-media flow, and it removes an entire class of credential handling.
- **Celery** — `arq` is async-native and matches the FastAPI/`asyncio` stack
  without a broker abstraction layer.
- **Django** — FastAPI + SQLAlchemy gives explicit async control the app needs
  for WebSockets and the worker.
- **Any auth provider other than username + password** — the brief's data model
  is usernames; an external IdP would add a redirect flow and a dependency.

---

## Trade-offs I accepted

- **Async processing for a fast response.** The upload returns `202` before the
  audio is playable. Covered by an explicit `pending` status and a live
  transition, but it is a state the client has to render.
- **Query-string JWT on the WebSocket.** The browser `WebSocket` API cannot send
  an `Authorization` header. The token ends up in server/proxy logs more easily
  than a header would. Acceptable for local use; a real deployment would use a
  short-lived, single-use WS ticket.
- **In-process presence.** The connection manager is a module-level singleton.
  Fine for one API process; wrong the moment there are two. The pub/sub fan-out
  is already Redis-based, so moving presence there is the obvious next step.
- **Vite dev server in the frontend container.** Right for a review build (fast,
  hot reload); a production image would build static assets and serve them from
  Nginx.
- **A pure `PlaybackQueue` class instead of a hook-only implementation.** More
  indirection, but it makes ordering and no-overlap rules unit-testable without a
  DOM, which is where the bugs actually live.

---

## What I would do with twice the time

1. **Move presence into Redis** so the API can run more than one replica, and
   replace query-string JWTs with short-lived WebSocket tickets minted over
   authenticated HTTP.
2. **Fix the known limitations above**, one commit each, starting with the
   validation-error input echo and the media-existence leak.
3. **Harden the worker**: retries with backoff for transient ffmpeg failures, a
   dead-letter state, and a reaper for rows stuck in `pending` (the test suite
   already exercises `reap_stale_processing`).
4. **Frontend polish**: optimistic send already exists; add an explicit failed-
   upload retry, a real waveform scrubber with seeking, and per-channel unread
   counts.
5. **Observability**: structured request logs already exist; add latency and
   queue-depth metrics, and trace a clip end-to-end from upload to `played`.
6. **Broader tests**: a Playwright pass that opens two real browser contexts and
   asserts the full record → send → play → status flow, plus contract tests
   between the socket event shapes and the client reducer.
7. **A production frontend image** (static build behind Nginx) and a Compose
   profile that switches between dev and prod.
