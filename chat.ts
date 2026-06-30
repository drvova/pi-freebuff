/**
 * Cloud-direct streaming chat via WebSocket.
 * Translates OpenAI chat requests → Freebuff/Codebuff JSON-RPC 2.0 wire format,
 * streams responses back as SSE events.
 */
import * as crypto from "crypto";
import WebSocket from "ws";
import {
  buildFreebuffMessage,
  buildJsonRpcRequest,
  buildFreebuffPing,
  parseFreebuffMessage,
  type FreebuffEnvelope,
  type JsonRpcMessage,
} from "./wire";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

const WS_CONNECT_TIMEOUT_MS = 30_000;
const WS_IDLE_TIMEOUT_MS = 120_000;
const WS_PING_INTERVAL_MS = 30_000;

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64Data: string; caption?: string };

export interface ChatHistoryItem {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export type CloudChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
  | { kind: "usage"; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { kind: "meta"; fields: ResponseMeta };

export interface ResponseMeta {
  outputId?: string;
  requestId?: string;
  model?: string;
  rawFields: Record<string, unknown>;
}

export interface CloudChatRequest {
  apiKey: string;
  backendUrl: string;
  modelUid: string;
  messages: ChatHistoryItem[];
  tools?: ToolDef[];
  completionOpts?: { maxOutputTokens?: number; temperature?: number };
  inferenceConfig?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class CloudChatError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "CloudChatError";
  }
}

// ----------------------------------------------------------------------------
// Content normalization
// ----------------------------------------------------------------------------

function normalizeContent(content: string | ContentPart[] | unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: ContentPart[] = [];
  for (const p of content as Array<Record<string, unknown>>) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "image_url" && p.image_url) {
      const imgRef = p.image_url as string | { url?: string };
      const url: string = typeof imgRef === "string" ? imgRef : (imgRef.url ?? "");
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) out.push({ type: "image", mimeType: m[1], base64Data: m[2] });
    }
  }
  return out;
}

function contentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// ----------------------------------------------------------------------------
// WebSocket connection pool
// ----------------------------------------------------------------------------

interface WsConnection {
  ws: WebSocket;
  host: string;
  apiKey: string;
  lastUsed: number;
  alive: boolean;
}

const connections = new Map<string, WsConnection>();
let pingInterval: ReturnType<typeof setInterval> | null = null;

function connKey(host: string, apiKey: string): string {
  return `${host}\x1f${apiKey}`;
}

function ensurePingInterval(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    for (const [key, conn] of connections) {
      if (!conn.alive || Date.now() - conn.lastUsed > WS_IDLE_TIMEOUT_MS) {
        try { conn.ws.close(); } catch {}
        connections.delete(key);
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch {}
    }
  }, WS_PING_INTERVAL_MS);
}

async function getConnection(
  backendUrl: string,
  apiKey: string,
  authToken: string,
  signal?: AbortSignal,
): Promise<WsConnection> {
  const host = backendUrl.replace(/\/$/, "");
  const key = connKey(host, apiKey);
  const existing = connections.get(key);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.lastUsed = Date.now();
    existing.alive = true;
    return existing;
  }

  const wsUrl = host.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl, {
    headers: { authToken },
  });

  const conn = await new Promise<WsConnection>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new CloudChatError(`WebSocket connect timeout (${WS_CONNECT_TIMEOUT_MS}ms)`, "timeout"));
    }, WS_CONNECT_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      ws.close();
      reject(new CloudChatError("WebSocket connect cancelled", "cancelled"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const connection: WsConnection = {
        ws,
        host,
        apiKey,
        lastUsed: Date.now(),
        alive: true,
      };
      connections.set(key, connection);
      ensurePingInterval();
      resolve(connection);
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new CloudChatError(`WebSocket error: ${err.message}`, "ws_error"));
    });

    ws.on("pong", () => {
      const c = connections.get(key);
      if (c) c.alive = true;
    });
  });

  return conn;
}

export function clearSessionIds(): void {
  for (const [, conn] of connections) {
    try { conn.ws.close(); } catch {}
  }
  connections.clear();
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ----------------------------------------------------------------------------
// Message builders
// ----------------------------------------------------------------------------

function buildChatRequest(req: CloudChatRequest): string {
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: contentToText(m.content),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  }));

  // Build request with all supported fields
  const params: Record<string, unknown> = {
    model: req.modelUid,
    messages,
    stream: true,
    max_tokens: req.completionOpts?.maxOutputTokens ?? 128_000,
    temperature: req.completionOpts?.temperature ?? 0.7,
  };

  // Add tools if provided
  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools;
  }

  // Add inference config if provided (provider-specific settings)
  if (req.inferenceConfig) {
    params.inference_config = req.inferenceConfig;
  }

  const jsonRpcMsg = buildJsonRpcRequest("chat", params);
  return buildFreebuffMessage(jsonRpcMsg);
}

// ----------------------------------------------------------------------------
// Response decoder
// ----------------------------------------------------------------------------

function* decodeFreebuffEvents(
  envelope: FreebuffEnvelope,
  requestId: string,
): Generator<CloudChatEvent> {
  // Handle ping/pong
  if (envelope.type === "ping") return;
  if (envelope.type === "pong") return;

  // Handle JSON-RPC response
  if (envelope.type === "message" && envelope.message) {
    const msg = envelope.message;

    // Check for error
    if ("error" in msg) {
      const err = msg as { error: { code: number; message: string } };
      throw new CloudChatError(err.error.message, String(err.error.code));
    }

    // Check for result
    if ("result" in msg) {
      const result = msg.result as Record<string, unknown>;

      // Streaming text delta
      if (result.type === "text" || result.type === "text_delta") {
        const text = result.text ?? result.delta ?? "";
        if (typeof text === "string" && text) {
          yield { kind: "text", text };
        }
      }

      // Reasoning/thinking delta
      if (result.type === "reasoning" || result.type === "thinking_delta") {
        const text = result.text ?? result.delta ?? "";
        if (typeof text === "string" && text) {
          yield { kind: "reasoning", text };
        }
      }

      // Tool call start
      if (result.type === "tool_call_start") {
        const id = result.id ?? result.tool_call_id ?? "";
        const name = result.name ?? result.tool_name ?? "";
        if (typeof id === "string" && typeof name === "string") {
          yield { kind: "tool_call_start", id, name };
        }
      }

      // Tool call arguments
      if (result.type === "tool_call_args" || result.type === "tool_call_delta") {
        const argsDelta = result.arguments ?? result.args_delta ?? result.delta ?? "";
        const id = result.id ?? result.tool_call_id;
        if (typeof argsDelta === "string") {
          yield {
            kind: "tool_call_args",
            argsDelta,
            ...(typeof id === "string" ? { id } : {}),
          };
        }
      }

      // Finish
      if (result.type === "done" || result.type === "finished" || result.type === "complete") {
        yield { kind: "finish", reason: "stop" };
      }

      // Error in result
      if (result.type === "error") {
        const message = result.message ?? result.error ?? "Unknown error";
        throw new CloudChatError(String(message), "stream_error");
      }

      // Usage
      if (result.usage) {
        const usage = result.usage as Record<string, unknown>;
        yield {
          kind: "usage",
          promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
          completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
          totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
        };
      }

      // Metadata
      yield {
        kind: "meta",
        fields: {
          outputId: result.output_id as string | undefined,
          requestId: result.request_id as string | undefined,
          model: result.model as string | undefined,
          rawFields: result,
        },
      };
    }
  }

  // Handle event type
  if (envelope.type === "event") {
    const event = envelope.event ?? "";
    const data = envelope.data as Record<string, unknown> | undefined;

    if (event === "text" || event === "text_delta") {
      const text = data?.text ?? data?.delta ?? "";
      if (typeof text === "string" && text) {
        yield { kind: "text", text };
      }
    }

    if (event === "reasoning" || event === "thinking_delta") {
      const text = data?.text ?? data?.delta ?? "";
      if (typeof text === "string" && text) {
        yield { kind: "reasoning", text };
      }
    }

    if (event === "tool_call" || event === "tool_call_start") {
      const id = data?.id ?? data?.tool_call_id ?? "";
      const name = data?.name ?? data?.tool_name ?? "";
      if (typeof id === "string" && typeof name === "string") {
        yield { kind: "tool_call_start", id, name };
      }
    }

    if (event === "tool_call_args" || event === "tool_call_delta") {
      const argsDelta = data?.arguments ?? data?.args_delta ?? data?.delta ?? "";
      const id = data?.id ?? data?.tool_call_id;
      if (typeof argsDelta === "string") {
        yield {
          kind: "tool_call_args",
          argsDelta,
          ...(typeof id === "string" ? { id } : {}),
        };
      }
    }

    if (event === "done" || event === "finished" || event === "complete") {
      yield { kind: "finish", reason: "stop" };
    }

    if (event === "error") {
      const message = data?.message ?? data?.error ?? "Unknown error";
      throw new CloudChatError(String(message), "stream_error");
    }

    if (event === "usage" && data) {
      yield {
        kind: "usage",
        promptTokens: typeof data.prompt_tokens === "number" ? data.prompt_tokens : undefined,
        completionTokens: typeof data.completion_tokens === "number" ? data.completion_tokens : undefined,
        totalTokens: typeof data.total_tokens === "number" ? data.total_tokens : undefined,
      };
    }
  }
}

// ----------------------------------------------------------------------------
// Public API: streamChatEvents
// ----------------------------------------------------------------------------

export async function* streamChatEvents(req: CloudChatRequest): AsyncGenerator<CloudChatEvent> {
  const host = req.backendUrl.replace(/\/$/, "");
  const requestId = crypto.randomUUID();

  // Get or create WebSocket connection
  const conn = await getConnection(host, req.apiKey, req.apiKey, req.signal);

  // Build and send request
  const requestJson = buildChatRequest(req);
  conn.ws.send(requestJson);
  conn.lastUsed = Date.now();

  // Collect responses
  let finished = false;
  let error: Error | null = null;

  const messagePromise = new Promise<FreebuffEnvelope[]>((resolve) => {
    const messages: FreebuffEnvelope[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        resolve(messages);
      }, WS_IDLE_TIMEOUT_MS);
    };

    const onMessage = (data: WebSocket.RawData) => {
      const raw = data.toString("utf8");
      const envelope = parseFreebuffMessage(raw);
      if (envelope) {
        messages.push(envelope);
        resetIdle();

        // Check for terminal events
        if (envelope.type === "event") {
          const event = envelope.event ?? "";
          if (event === "done" || event === "finished" || event === "complete" || event === "error") {
            finished = true;
            if (idleTimer) clearTimeout(idleTimer);
            conn.ws.removeListener("message", onMessage);
            resolve(messages);
          }
        }
        if (envelope.type === "message" && envelope.message) {
          const msg = envelope.message;
          if ("result" in msg) {
            const result = msg.result as Record<string, unknown>;
            if (result.type === "done" || result.type === "finished" || result.type === "complete") {
              finished = true;
              if (idleTimer) clearTimeout(idleTimer);
              conn.ws.removeListener("message", onMessage);
              resolve(messages);
            }
            if (result.type === "error") {
              finished = true;
              error = new Error(String(result.message ?? result.error));
              if (idleTimer) clearTimeout(idleTimer);
              conn.ws.removeListener("message", onMessage);
              resolve(messages);
            }
          }
          if ("error" in msg) {
            finished = true;
            const err = msg as { error: { message: string } };
            error = new Error(err.error.message);
            if (idleTimer) clearTimeout(idleTimer);
            conn.ws.removeListener("message", onMessage);
            resolve(messages);
          }
        }
      }
    };

    conn.ws.on("message", onMessage);
    resetIdle();

    // Handle abort
    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        if (idleTimer) clearTimeout(idleTimer);
        conn.ws.removeListener("message", onMessage);
        resolve(messages);
      }, { once: true });
    }
  });

  const messages = await messagePromise;

  // Yield decoded events
  for (const envelope of messages) {
    if (error && !(envelope.type === "message" && "error" in (envelope.message ?? {}))) {
      // Already captured error
    }
    yield* decodeFreebuffEvents(envelope, requestId);
  }

  // Throw if error was captured
  if (error) {
    throw new CloudChatError(error.message, "stream_error");
  }

  // If we didn't get a finish event, emit one
  if (!finished) {
    yield { kind: "finish", reason: "stop" };
  }
}
