import type { AggregatedStatus, Message, MessageStatus } from "../api/types";

/**
 * The message shape the backend puts on the socket.
 *
 * Deliberately separate from `Message`: the REST row always carries counts and
 * a username, while a replayed socket message does not (see `message_payload`
 * in the backend) and a `message.new` from the worker only sometimes does.
 * Keeping the partials partial is what stops the client inventing zeros that
 * would overwrite real counts.
 */
export interface ServerMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_username?: string;
  status: MessageStatus;
  duration_seconds: number | null;
  waveform_peaks: number[] | null;
  failure_reason: string | null;
  created_at: string;
  sequence: number;
  delivered_count?: number;
  played_count?: number;
  recipient_count?: number;
  aggregated_status?: AggregatedStatus;
}

export type ServerEvent =
  | { type: "message.new"; data: ServerMessage }
  | { type: "message.replay"; data: ServerMessage }
  | { type: "message.failed"; data: { message_id: string; reason: string } }
  | { type: "message.status"; data: { message_id: string; aggregated: AggregatedStatus } }
  | { type: "pong" };

/**
 * Turns a raw frame into a known event, or null.
 *
 * Anything unrecognised is dropped rather than rendered: the socket is also
 * where a proxy or a future backend version can send something this client has
 * no business guessing at.
 */
export function parseServerEvent(raw: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { type, data } = value as { type?: unknown; data?: unknown };
  switch (type) {
    case "message.new":
    case "message.replay":
      // A malformed payload would surface as an undefined id downstream; the
      // shape is trusted here because it comes from our own backend.
      if (typeof data !== "object" || data === null) {
        return null;
      }
      return { type, data: data as ServerMessage };
    case "message.failed":
      if (typeof data !== "object" || data === null) {
        return null;
      }
      return { type, data: data as { message_id: string; reason: string } };
    case "message.status":
      if (typeof data !== "object" || data === null) {
        return null;
      }
      return { type, data: data as { message_id: string; aggregated: AggregatedStatus } };
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

function merge(messages: Message[], incoming: Message): Message[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) {
    // Newest first, the order the API and the transcript use. Sorting rather
    // than prepending matters for replay, which arrives oldest-first and would
    // otherwise be inserted backwards.
    return [...messages, incoming].sort((a, b) => b.sequence - a.sequence);
  }
  const next = [...messages];
  next[index] = incoming;
  return next;
}

/**
 * Applies one socket event to the transcript.
 *
 * Pure so the merge rules can be tested without a socket: replayed messages
 * must not duplicate live ones, a partial payload must not erase counts it did
 * not carry, and the list must stay newest-first.
 */
export function applyServerEvent(
  messages: Message[],
  event: ServerEvent,
  usernameFor: (senderId: string) => string | undefined,
): Message[] {
  switch (event.type) {
    case "message.new":
    case "message.replay": {
      const data = event.data;
      const existing = messages.find((message) => message.id === data.id);
      const merged: Message = {
        id: data.id,
        channel_id: data.channel_id,
        sender_id: data.sender_id,
        // Replayed payloads omit the username; fall back to the current value
        // and then the member roster before showing a blank name.
        sender_username:
          data.sender_username ?? existing?.sender_username ?? usernameFor(data.sender_id) ?? "unknown",
        status: data.status,
        duration_seconds: data.duration_seconds,
        waveform_peaks: data.waveform_peaks,
        failure_reason: data.failure_reason,
        created_at: data.created_at,
        sequence: data.sequence,
        delivered_count: data.delivered_count ?? existing?.delivered_count ?? 0,
        played_count: data.played_count ?? existing?.played_count ?? 0,
        recipient_count: data.recipient_count ?? existing?.recipient_count ?? 0,
        aggregated_status: data.aggregated_status ?? existing?.aggregated_status ?? "sent",
      };
      return merge(messages, merged);
    }
    case "message.failed":
      return messages.map((message) =>
        message.id === event.data.message_id
          ? { ...message, status: "failed" as MessageStatus, failure_reason: event.data.reason }
          : message,
      );
    case "message.status":
      return messages.map((message) =>
        message.id === event.data.message_id
          ? { ...message, aggregated_status: event.data.aggregated }
          : message,
      );
    case "pong":
      return messages;
  }
}
