# AI usage

This project was built with heavy AI assistance. This note says where AI was
used, where it was not, and how its output was checked. The honest summary is:
AI wrote most of the keystrokes; a human made every design decision, ran every
command, and verified every result.

## Tools used

- **An LLM coding assistant (opencode)** — used interactively for the whole
  build: writing code, proposing designs, explaining errors, and drafting the
  per-commit write-ups. It ran in the repository as an agent, so it could read
  files, run tests, and edit code in place.
- **The assistant's shell access** — it ran `git`, `docker compose`, `pytest`,
  `npm`, and `curl` to check its own work. Those commands and their real output
  are the record of what was actually verified (see below).
- **No AI ran in the product.** Nothing in `backend/` or `frontend/` calls an LLM
  at runtime. There is no inference dependency anywhere in the stack.

## What it was used for

- **Backend implementation.** FastAPI routers, SQLAlchemy models and the Alembic
  migration, the JWT auth flow, the upload + `ffprobe` validation path, the arq
  worker that transcodes with `ffmpeg`, the Redis pub/sub fan-out and the
  WebSocket connection manager, the media endpoint, and the pytest suite.
- **Frontend implementation.** The Vite + TypeScript scaffold, the auth context
  and fetch client, the channel list and channel pages, the `MediaRecorder`
  wrapper and hold-to-record button, the playback queue, the WebSocket hook and
  reconnect/catch-up logic, and the Vitest suite.
- **Explanations.** After each commit, a detailed walkthrough was written
  (`commit-notes/`, gitignored) translating every Python piece back to its Node
  equivalent, because the developer's background is Node/TypeScript. Those notes
  are study material, not part of the deliverable.
- **Drafting these docs.** `README.md`, `DECISIONS.md`, and this file were
  drafted by the assistant from the actual code and then reviewed and corrected
  against it.

## What it was not used for

- **The spec and scope.** `SPEC.md` was given, not generated. All trade-off and
  scope decisions (what to cut, the async upload model, keyset pagination,
  per-user status, the WebSocket protocol deviations) were made by the human,
  with the assistant laying out options and consequences.
- **Unsigned-off "verification".** No result in this repo rests on an AI claiming
  success. Every claim in `DECISIONS.md` and every commit body corresponds to a
  command that was run and an output that was seen — a failing test made to pass
  or a passing test made to fail on purpose.

## How AI output was checked

- **The test suites were run, not assumed.** `pytest` in the backend container
  and `npm test` in the frontend. Counts and failures were read from real
  terminal output.
- **Mutation checks for the important logic.** To show a test actually tests
  something, the code was deliberately broken and the expected failure observed,
  then reverted. Examples: `if False:` on the duration caps made the
  too-short/too-long tests return `202` instead of `400`; deleting the sort in
  the socket reducer failed the replay-ordering test; removing the own-sender
  skip from the playback queue failed four tests. A green suite alone was not
  treated as proof.
- **End-to-end runs, not just unit tests.** Real audio was recorded/uploaded and
  played through `ffmpeg`; the WebSocket flow was exercised with a real
  WebSocket client against the running stack, including a disconnect and a
  catch-up replay.
- **Read-back review.** The assistant's edits were read back to catch things
  like the `FormData` content-type bug (which would have stripped the multipart
  boundary) and to keep the "no dead code, no `any`" rules.
- **Mistakes were kept in the record.** When the end-to-end WebSocket harness
  asserted a `201` from `POST /auth/signup` and failed, that was a bug in the
  test (the endpoint returns `200`), and it was written down as such rather than
  quietly fixed and hidden.

## Limitations of the AI-assisted approach

- The known gaps in `README.md` and `DECISIONS.md` are exactly that — known.
  They are listed rather than left for a reviewer to discover, and each has a
  concrete fix sketched.
- AI-written code still needs human judgement about *why*, not just *whether it
  runs*. The `DECISIONS.md` content is the human's reasoning; the code is where
  the assistant did most of the typing.
