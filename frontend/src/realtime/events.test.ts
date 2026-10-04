import { describe, expect, it } from "vitest";

import { applyServerEvent, parseServerEvent } from "./events";
import type { ServerMessage } from "./events";
import type { Message } from "../api/types";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    channel_id: "c1",
    sender_id: "other",
    sender_username: "other",
    status: "ready",
    duration_seconds: 1.5,
    waveform_peaks: [0.1, 0.2],
    failure_reason: null,
    created_at: "2026-10-03T00:00:00Z",
    sequence: 1,
    delivered_count: 0,
    played_count: 0,
    recipient_count: 1,
    aggregated_status: "sent",
    ...overrides,
  };
}

function serverMessage(overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: "m2",
    channel_id: "c1",
    sender_id: "other",
    status: "ready",
    duration_seconds: 2,
    waveform_peaks: [0.5],
    failure_reason: null,
    created_at: "2026-10-03T00:00:05Z",
    sequence: 2,
    ...overrides,
  };
}

const noUsernames = () => undefined;

describe("parseServerEvent", () => {
  it("parses a known event", () => {
    const event = parseServerEvent('{"type":"pong"}');
    expect(event).toEqual({ type: "pong" });
  });

  it("drops unknown, malformed, and non-object frames", () => {
    expect(parseServerEvent("not json")).toBeNull();
    expect(parseServerEvent('{"type":"presence","data":{}}')).toBeNull();
    expect(parseServerEvent('{"type":"message.new"}')).toBeNull();
    expect(parseServerEvent("42")).toBeNull();
  });
});

describe("applyServerEvent", () => {
  it("inserts a new message newest-first", () => {
    const existing = [message({ id: "m3", sequence: 3 })];
    const next = applyServerEvent(existing, { type: "message.new", data: serverMessage() }, noUsernames);

    expect(next.map((entry) => entry.sequence)).toEqual([3, 2]);
  });

  it("keeps replayed messages in order even though they arrive oldest-first", () => {
    let state = [message({ id: "m3", sequence: 3 })];
    state = applyServerEvent(state, { type: "message.replay", data: serverMessage({ id: "m1", sequence: 1 }) }, noUsernames);
    state = applyServerEvent(state, { type: "message.replay", data: serverMessage({ id: "m2", sequence: 2 }) }, noUsernames);

    expect(state.map((entry) => entry.sequence)).toEqual([3, 2, 1]);
  });

  it("updates a replayed message instead of duplicating a live one", () => {
    const existing = [message({ id: "m2", sequence: 2, status: "ready" })];
    const next = applyServerEvent(
      existing,
      { type: "message.replay", data: serverMessage({ id: "m2", sequence: 2, status: "ready" }) },
      noUsernames,
    );

    expect(next).toHaveLength(1);
  });

  it("fills a missing username from the roster", () => {
    const next = applyServerEvent(
      [],
      { type: "message.replay", data: serverMessage({ sender_id: "u9" }) },
      (id) => (id === "u9" ? "sara" : undefined),
    );

    expect(next[0]?.sender_username).toBe("sara");
  });

  it("keeps known counts when a partial payload omits them", () => {
    const existing = [message({ id: "m2", sequence: 2, delivered_count: 1, played_count: 1, aggregated_status: "played" })];
    // message.new from the worker carries no counts at all.
    const next = applyServerEvent(
      existing,
      { type: "message.new", data: serverMessage({ id: "m2", sequence: 2 }) },
      noUsernames,
    );

    expect(next[0]?.delivered_count).toBe(1);
    expect(next[0]?.played_count).toBe(1);
    expect(next[0]?.aggregated_status).toBe("played");
  });

  it("applies a status update", () => {
    const existing = [message({ id: "m2", sequence: 2 })];
    const next = applyServerEvent(
      existing,
      { type: "message.status", data: { message_id: "m2", aggregated: "delivered" } },
      noUsernames,
    );

    expect(next[0]?.aggregated_status).toBe("delivered");
  });

  it("marks a message failed with its reason", () => {
    const existing = [message({ id: "m2", sequence: 2 })];
    const next = applyServerEvent(
      existing,
      { type: "message.failed", data: { message_id: "m2", reason: "ffmpeg exploded" } },
      noUsernames,
    );

    expect(next[0]?.status).toBe("failed");
    expect(next[0]?.failure_reason).toBe("ffmpeg exploded");
  });

  it("leaves the list untouched for pong", () => {
    const existing = [message()];
    const next = applyServerEvent(existing, { type: "pong" }, noUsernames);
    expect(next).toBe(existing);
  });
});
