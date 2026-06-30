/**
 * Cloud-direct chat via REST API.
 * Uses Codebuff's /api/v1/chat/completions endpoint with Bearer token auth.
 * Streams responses back as SSE events.
 */

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

// ---- Content helpers ----

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") return String((p as { text?: string }).text ?? "");
    if (p.type === "image_url") return "[image]";
    return "";
  }).join("");
}

// ---- Main streaming function ----

export async function streamCloudChat(req: CloudChatRequest): Promise<void> {
  const body: Record<string, unknown> = {
    model: req.modelUid,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: contentToText(m.content),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    })),
    stream: true,
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  if (req.completionOpts?.maxOutputTokens) body.max_tokens = req.completionOpts.maxOutputTokens;
  if (req.completionOpts?.temperature !== undefined) body.temperature = req.completionOpts.temperature;

  const response = await fetch(`${DEFAULT_REGION.api}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": "Bun/1.3.11",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CloudChatError(`HTTP ${response.status}: ${text.slice(0, 300)}`, "http_error", response.status);
  }

  if (!response.body) throw new CloudChatError("No response body", "no_body");

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
        if (data === "[DONE]") { finish("stop"); return; }

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
    }
    if (!finished) finish("stop");
  } catch (err) {
    if (!finished) { req.callbacks.onError?.(err); throw err; }
  }
}

// No-op: REST API has no persistent connections to clear
export function clearSessionIds(): void {}
