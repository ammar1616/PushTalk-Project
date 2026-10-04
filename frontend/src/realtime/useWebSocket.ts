import { useEffect, useRef, useState } from "react";

import * as api from "../api/client";
import { parseServerEvent } from "./events";
import type { ServerEvent } from "./events";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const PING_INTERVAL_MS = 25_000;

export interface UseWebSocketOptions {
  channelId: string;
  /** Highest sequence already held; the server replays everything above it. */
  sinceSequence: number;
  /** Held until history has loaded, so the first connect replays nothing. */
  enabled: boolean;
  onEvent(event: ServerEvent): void;
}

export interface WebSocketHandle {
  status: ConnectionStatus;
  attempts: number;
}

/**
 * A single WebSocket for one channel, with reconnect.
 *
 * Note on the protocol: SPEC describes a `subscribe` frame carrying
 * `since_sequence`, but the backend reads `channel_id` and `since_sequence`
 * from the connection query string and does not handle a subscribe frame. The
 * catch-up therefore happens by reconnecting with an updated `since_sequence`,
 * which is what this hook does. Recorded in DECISIONS.md.
 */
export function useWebSocket({ channelId, sinceSequence, enabled, onEvent }: UseWebSocketOptions): WebSocketHandle {
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [attempts, setAttempts] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const onEventRef = useRef(onEvent);
  const sinceRef = useRef(sinceSequence);

  // Read through refs so the socket effect does not depend on values that
  // change on every render (which would tear the connection down each time).
  onEventRef.current = onEvent;
  sinceRef.current = sinceSequence;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }
      setStatus((current) => (current === "reconnecting" ? current : "connecting"));
      const socket = new WebSocket(api.webSocketUrl(channelId, sinceRef.current));
      socketRef.current = socket;

      socket.onopen = () => {
        attemptsRef.current = 0;
        setAttempts(0);
        setStatus("open");
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const parsed = parseServerEvent(event.data);
        if (parsed !== null) {
          onEventRef.current(parsed);
        }
      };
      // onerror is always followed by onclose, so recovery lives in one place.
      socket.onerror = () => undefined;
      socket.onclose = () => {
        socketRef.current = null;
        schedule();
      };
    };

    const schedule = () => {
      if (disposed) {
        return;
      }
      // Exponential backoff capped at 10s, with jitter so that every tab in a
      // channel does not reconnect in lockstep after a shared blip.
      const attempt = attemptsRef.current;
      const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      attemptsRef.current = attempt + 1;
      setAttempts(attempt + 1);
      setStatus("reconnecting");
      timerRef.current = setTimeout(connect, delay + Math.random() * delay * 0.5);
    };

    connect();

    // Keeps a proxy from closing an idle socket.
    const ping = setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(ping);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [channelId, enabled]);

  return { status, attempts };
}
