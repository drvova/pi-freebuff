/**
 * Cloud-direct streaming chat via WebSocket.
 * Translates OpenAI chat requests → Freebuff/Codebuff JSON-RPC 2.0 wire format,
 * streams responses back as SSE events.
 *
 * Uses Node 22+ native WebSocket (no npm dependencies).
 */

import * as crypto from "crypto";
import { buildFreebuffMessage, buildJsonRpcRequest, parseFreebuffMessage, type FreebuffEnvelope } from "./wire";

// Use native WebSocket (Node 22+)
const WS = globalThis.WebSocket;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; [key: string]: unknown }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type StreamEventType =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "ping";

export interface StreamEvent {
  type: StreamEventType;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; [key: string]: unknown };
  message?: { id?: string; role?: string; model?: string; [key: string]: unknown };
  usage?: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CloudChatCallbacks {
  onStart?: () => void;
  onEvent?: (event: StreamEvent) => void;
  onText?: (text: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (id: string, result: string) => void;
  onThinking?: (text: string) => void;
  onFinish?: (reason: string) => void;
  onError?: (error: unknown) => void;
}

export interface CloudChatRequest {
  apiKey: string;
  backendUrl: string;
  modelUid: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  completionOpts?: { maxOutputTokens?: number; temperature?: number };
  inferenceConfig?: Record<string, unknown>;
  signal?: AbortSignal;
  callbacks: CloudChatCallbacks;
}

export class CloudChatError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
  ) {
    super(message);
    this.name = "CloudChatError";
  }
}

// ----------------------------------------------------------------------------
// WebSocket connection pool
// ----------------------------------------------------------------------------

const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_IDLE_TIMEOUT_MS = 30_000;

interface WsConn {
  ws: WS;
  apiKey: string;
  backendUrl: string;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
}

let pooled: WsConn | null = null;

function idleSweep() {
  if (!pooled) return;
  const now = Date.now();
  if (now - pooled.lastUsedAt > WS_IDLE_TIMEOUT_MS) {
    try { pooled.ws.close(); } catch {}
    pooled = null;
  }
}

setInterval(idleSweep, 10_000);

function connectWs(apiKey: string, backendUrl: string): Promise<WsConn> {
  const host = backendUrl.replace(/\/$/, "");
  const wsUrl = host.replace(/^http/, "ws") + "/ws";

  return new Promise<WsConn>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch {}
        reject(new CloudChatError(`WebSocket connect timeout (${WS_CONNECT_TIMEOUT_MS}ms)`, "timeout"));
      }
    }, WS_CONNECT_TIMEOUT_MS);

    const ws = new WS(wsUrl, { headers: { authToken: apiKey } });

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          ws,
          apiKey,
          backendUrl,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          busy: false,
        });
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new CloudChatError("WebSocket connection failed", "ws_error"));
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new CloudChatError("WebSocket closed during connect", "ws_closed"));
      }
    });

    if (typeof AbortController !== "undefined") {
      const ac = new AbortController();
      ac.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new CloudChatError("WebSocket connect cancelled", "cancelled"));
        }
      }, { once: true });
    }
  });
}

async function getConn(apiKey: string, backendUrl: string): Promise<WsConn> {
  if (pooled && pooled.apiKey === apiKey && pooled.backendUrl === backendUrl) {
    if (pooled.ws.readyState === WS.OPEN && !pooled.busy) {
      pooled.lastUsedAt = Date.now();
      return pooled;
    }
    try { pooled.ws.close(); } catch {}
    pooled = null;
  }
  const conn = await connectWs(apiKey, backendUrl);
  pooled = conn;
  return conn;
}

// ----------------------------------------------------------------------------
// Request builder
// ----------------------------------------------------------------------------

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "text") return String((p as { text?: string }).text ?? "");
      if (p.type === "image_url") return "[image]";
      if (p.type === "image_file") return "[image]";
      return "";
    })
    .join("");
}

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

interface DecodeResult {
  done: boolean;
  textDeltas: string[];
  thinkingDeltas: string[];
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  error: string | null;
}

function decodeStreamEvent(raw: string): DecodeResult {
  const result: DecodeResult = {
    done: false,
    textDeltas: [],
    thinkingDeltas: [],
    toolCalls: [],
    finishReason: null,
    usage: null,
    error: null,
  };

  const envelope = parseFreebuffMessage(raw);
  if (!envelope) return result;

  // Handle error events
  if (envelope.type === "event" && envelope.event === "error") {
    const data = envelope.data as Record<string, unknown>;
    result.error = String(data?.message ?? data?.error ?? "Unknown backend error");
    result.done = true;
    return result;
  }

  // Handle completion events
  if (envelope.type === "event" && envelope.event === "complete") {
    const data = envelope.data as Record<string, unknown>;
    result.finishReason = String(data?.reason ?? "stop");
    if (data.usage) {
      result.usage = data.usage as { input_tokens: number; output_tokens: number };
    }
    result.done = true;
    return result;
  }

  // Handle JSON-RPC responses with content deltas
  if (envelope.type === "message" && envelope.message) {
    const msg = envelope.message as Record<string, unknown>;

    // Check for result (completion)
    if ("result" in msg) {
      result.done = true;
      result.finishReason = "stop";
      return result;
    }

    // Check for error
    if ("error" in msg) {
      result.error = String((msg.error as Record<string, unknown>)?.message ?? "JSON-RPC error");
      result.done = true;
      return result;
    }

    // Handle streaming chunks
    if ("choices" in msg) {
      const choices = msg.choices as Array<Record<string, unknown>>;
      for (const choice of choices) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Text content
        if (typeof delta.content === "string" && delta.content) {
          result.textDeltas.push(delta.content);
        }

        // Tool calls
        if (delta.tool_calls) {
          const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
          for (const tc of toolCalls) {
            const fn = tc.function as Record<string, unknown> | undefined;
            result.toolCalls.push({
              index: typeof tc.index === "number" ? tc.index : 0,
              id: String(tc.id ?? ""),
              name: String(fn?.name ?? ""),
              arguments: String(fn?.arguments ?? ""),
            });
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          result.finishReason = String(choice.finish_reason);
        }
      }

      // Usage
      if (msg.usage) {
        result.usage = msg.usage as { input_tokens: number; output_tokens: number };
      }
    }
  }

  // Handle action-type messages
  if (envelope.type === "action" && envelope.action) {
    const data = envelope.data as Record<string, unknown>;
    if (envelope.action === "content_delta" && typeof data?.text === "string") {
      result.textDeltas.push(data.text);
    }
    if (envelope.action === "thinking_delta" && typeof data?.text === "string") {
      result.thinkingDeltas.push(data.text);
    }
    if (envelope.action === "tool_call" && data?.name) {
      result.toolCalls.push({
        index: 0,
        id: String(data.id ?? crypto.randomUUID()),
        name: String(data.name),
        arguments: typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {}),
      });
    }
    if (envelope.action === "done") {
      result.done = true;
      result.finishReason = "stop";
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// Main streaming function
// ----------------------------------------------------------------------------

export async function streamCloudChat(req: CloudChatRequest): Promise<void> {
  const conn = await getConn(req.apiKey, req.backendUrl);
  const requestJson = buildChatRequest(req);

  // Accumulator for tool call arguments
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  return new Promise<void>((resolve, reject) => {
    let finished = false;

    const finish = (reason: string, err?: unknown) => {
      if (finished) return;
      finished = true;

      // Flush any accumulated tool calls
      for (const [, tc] of toolCallAccum) {
        if (tc.name && tc.args) {
          try {
            req.callbacks.onToolCall?.(tc.name, JSON.parse(tc.args));
          } catch {}
        }
      }
      toolCallAccum.clear();

      try { conn.ws.close(); } catch {}
      if (pooled === conn) pooled = null;

      if (err) {
        req.callbacks.onError?.(err);
        reject(err);
      } else {
        req.callbacks.onFinish?.(reason);
        resolve();
      }
    };

    // Abort signal
    req.signal?.addEventListener("abort", () => {
      finish("aborted", new CloudChatError("Request aborted", "aborted"));
    }, { once: true });

    // Timeout
    const timer = setTimeout(() => {
      finish("timeout", new CloudChatError("Stream timeout (5 minutes)", "timeout"));
    }, 5 * 60 * 1000);

    req.callbacks.onStart?.();

    const onData = (event: MessageEvent) => {
      if (finished) return;
      conn.lastUsedAt = Date.now();

      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const result = decodeStreamEvent(raw);

      if (result.error) {
        clearTimeout(timer);
        finish("error", new CloudChatError(result.error, "backend_error"));
        return;
      }

      // Emit thinking deltas
      for (const td of result.thinkingDeltas) {
        req.callbacks.onThinking?.(td);
      }

      // Emit text deltas
      for (const td of result.textDeltas) {
        req.callbacks.onText?.(td);
      }

      // Accumulate tool calls
      for (const tc of result.toolCalls) {
        let acc = toolCallAccum.get(tc.index);
        if (!acc) {
          acc = { id: tc.id || crypto.randomUUID(), name: tc.name, args: "" };
          toolCallAccum.set(tc.index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.name) acc.name = tc.name;
        if (tc.arguments) acc.args += tc.arguments;
      }

      // Handle completion
      if (result.done) {
        clearTimeout(timer);
        finish(result.finishReason ?? "stop");
        return;
      }
    };

    const onError = (event: Event) => {
      if (finished) return;
      clearTimeout(timer);
      const msg = event instanceof ErrorEvent ? event.message : "WebSocket error";
      finish("error", new CloudChatError(msg, "ws_error"));
    };

    const onClose = () => {
      if (finished) return;
      clearTimeout(timer);
      finish("closed");
    };

    conn.ws.addEventListener("message", onData);
    conn.ws.addEventListener("error", onError);
    conn.ws.addEventListener("close", onClose);

    // Send the request
    try {
      conn.ws.send(requestJson);
    } catch (err) {
      clearTimeout(timer);
      conn.ws.removeEventListener("message", onData);
      conn.ws.removeEventListener("error", onError);
      conn.ws.removeEventListener("close", onClose);
      finish("send_error", err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ----------------------------------------------------------------------------
// Non-streaming request (used for tool result submission)
// ----------------------------------------------------------------------------

export async function submitToolResult(
  apiKey: string,
  backendUrl: string,
  toolCallId: string,
  result: string,
  signal?: AbortSignal,
): Promise<void> {
  const conn = await getConn(apiKey, backendUrl);
  const jsonRpcMsg = buildJsonRpcRequest("tool_result", {
    tool_call_id: toolCallId,
    result,
  });
  const requestJson = buildFreebuffMessage(jsonRpcMsg);

  return new Promise<void>((resolve, reject) => {
    let finished = false;

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      try { conn.ws.close(); } catch {}
      if (pooled === conn) pooled = null;
      if (err) reject(err);
      else resolve();
    };

    signal?.addEventListener("abort", () => finish(new CloudChatError("Aborted", "aborted")), { once: true });
    const timer = setTimeout(() => finish(new CloudChatError("Timeout", "timeout")), 30_000);

    const onData = () => { clearTimeout(timer); finish(); };
    conn.ws.addEventListener("message", onData, { once: true });
    conn.ws.addEventListener("error", () => { clearTimeout(timer); finish(new CloudChatError("WS error", "ws_error")); }, { once: true });

    try { conn.ws.send(requestJson); } catch (err) { clearTimeout(timer); finish(err); }
  });
}
