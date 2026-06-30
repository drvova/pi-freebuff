/**
 * Cloud-direct chat via REST API.
 * Uses Codebuff's session + run + chat completions flow.
 *
 * Flow per request:
 *   1. Reuse cached session (or POST /api/v1/freebuff/session to create)
 *   2. POST /api/v1/agent-runs {action:'START', agentId} — get runId
 *   3. POST /api/v1/chat/completions — send with runId
 *   4. POST /api/v1/agent-runs {action:'FINISH', runId} — finish
 *
 * Sessions are cached and reused to avoid 429 rate limits.
 */

import * as crypto from "crypto";
import { DEFAULT_REGION } from "./oauth";

// ---- Types ----

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; [key: string]: unknown }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CloudChatCallbacks {
  onStart?: () => void;
  onText?: (text: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onThinking?: (text: string) => void;
  onFinish?: (reason: string) => void;
  onError?: (error: unknown) => void;
}

export interface CloudChatRequest {
  apiKey: string;
  modelUid: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  completionOpts?: { maxOutputTokens?: number; temperature?: number };
  signal?: AbortSignal;
  callbacks: CloudChatCallbacks;
}

export class CloudChatError extends Error {
  constructor(message: string, public code: string, public status?: number) {
    super(message);
    this.name = "CloudChatError";
  }
}

// ---- Model → Agent mapping (from freebuff free-agents.ts) ----

const MODEL_TO_AGENT: Record<string, string> = {
  "minimax/minimax-m2.7": "base2-free",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "moonshotai/kimi-k2.6": "base2-free-kimi",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.5-pro": "base2-free-mimo-pro",
  "z-ai/glm-5.2": "base2-free-glm",
  "google/gemini-3.1-pro-preview": "base2-free",
};

function agentForModel(model: string): string {
  return MODEL_TO_AGENT[model] ?? "base2-free";
}

// ---- Content helpers ----

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") return String((p as { text?: string }).text ?? "");
    if (p.type === "image_url") return "[image]";
    return "";
  }).join("");
}

// ---- HTTP helpers ----

const API_BASE = DEFAULT_REGION.api;
const UA = "Bun/1.3.11";

async function apiPost(path: string, authToken: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    "authorization": `Bearer ${authToken}`,
    "user-agent": UA,
    "accept": "application/json",
    ...extraHeaders,
  };
  if (body) headers["content-type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function apiDelete(path: string, authToken: string): Promise<{ status: number }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "authorization": `Bearer ${authToken}`,
      "user-agent": UA,
      "accept": "application/json",
    },
  });
  return { status: res.status };
}

// ---- Session cache (reuse sessions to avoid 429) ----

interface CachedSession {
  model: string;
  createdAt: number;
}

const sessionCache = new Map<string, CachedSession>();
const SESSION_TTL_MS = 30 * 60_000; // 30 min

async function ensureSession(authToken: string, model: string): Promise<void> {
  const cached = sessionCache.get(authToken);
  if (cached && cached.model === model && Date.now() - cached.createdAt < SESSION_TTL_MS) {
    return; // Reuse existing session
  }

  // End old session if switching models
  if (cached && cached.model !== model) {
    await apiDelete("/api/v1/freebuff/session", authToken).catch(() => {});
    sessionCache.delete(authToken);
  }

  // Create new session
  const { status } = await apiPost("/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-model": model });
  if (status < 200 || status >= 300) {
    // 429 = rate limited, wait and retry once
    if (status === 429) {
      console.error("[freebuff] session 429, waiting 5s...");
      await new Promise(r => setTimeout(r, 5000));
      const retry = await apiPost("/api/v1/freebuff/session", authToken, undefined, { "x-freebuff-model": model });
      if (retry.status < 200 || retry.status >= 300) {
        throw new CloudChatError(`create session failed: HTTP ${retry.status}`, "session_error", retry.status);
      }
    } else {
      throw new CloudChatError(`create session failed: HTTP ${status}`, "session_error", status);
    }
  }

  sessionCache.set(authToken, { model, createdAt: Date.now() });
}

// ---- Run lifecycle ----

async function startRun(authToken: string, agentId: string): Promise<string> {
  const { status, data } = await apiPost("/api/v1/agent-runs", authToken, { action: "START", agentId });
  if (status < 200 || status >= 300) {
    throw new CloudChatError(`start run failed: HTTP ${status}`, "run_error", status);
  }
  const runId = (data as { runId?: string })?.runId ?? "";
  if (!runId) throw new CloudChatError(`start run missing runId: ${JSON.stringify(data)}`, "run_error");
  return runId;
}

async function finishRun(authToken: string, runId: string): Promise<void> {
  const { status } = await apiPost("/api/v1/agent-runs", authToken, {
    action: "FINISH", runId, status: "completed",
    totalSteps: 1, directCredits: 0, totalCredits: 0,
  });
  if (status < 200 || status >= 300) {
    console.error(`[freebuff] finish run failed: HTTP ${status}`);
  }
}

// ---- Main streaming function ----

export async function streamCloudChat(req: CloudChatRequest): Promise<void> {
  const agentId = agentForModel(req.modelUid);

  // 1. Ensure session (cached or create new)
  await ensureSession(req.apiKey, req.modelUid);

  // 2. Start run → get runId
  const runId = await startRun(req.apiKey, agentId);

  // 3. Build chat completion body
  const body: Record<string, unknown> = {
    model: req.modelUid,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: contentToText(m.content),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    })),
    stream: true,
    codebuff_metadata: {
      run_id: runId,
      cost_mode: "free",
      client_id: crypto.randomUUID(),
    },
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  if (req.completionOpts?.maxOutputTokens) body.max_tokens = req.completionOpts.maxOutputTokens;
  if (req.completionOpts?.temperature !== undefined) body.temperature = req.completionOpts.temperature;

  // 4. Send chat completion
  const response = await fetch(`${API_BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    await finishRun(req.apiKey, runId).catch(() => {});
    throw new CloudChatError(`HTTP ${response.status}: ${text.slice(0, 300)}`, "http_error", response.status);
  }

  if (!response.body) {
    await finishRun(req.apiKey, runId).catch(() => {});
    throw new CloudChatError("No response body", "no_body");
  }

  req.callbacks.onStart?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    for (const [, tc] of toolCallAccum) {
      if (tc.name && tc.args) {
        try { req.callbacks.onToolCall?.(tc.name, JSON.parse(tc.args)); } catch {}
      }
    }
    toolCallAccum.clear();
    req.callbacks.onFinish?.(reason);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { finish("stop"); break; }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) req.callbacks.onText?.(delta.content);

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              let acc = toolCallAccum.get(idx);
              if (!acc) { acc = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", args: "" }; toolCallAccum.set(idx, acc); }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          if (choice.finish_reason) finish(choice.finish_reason);
        } catch {}
      }
      if (finished) break;
    }
    if (!finished) finish("stop");
  } catch (err) {
    if (!finished) { req.callbacks.onError?.(err); throw err; }
  } finally {
    // 5. Finish run (best-effort)
    await finishRun(req.apiKey, runId).catch(() => {});
  }
}

// No-op: REST API has no persistent connections to clear
export function clearSessionIds(): void {}
