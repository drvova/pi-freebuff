/**
 * Dynamic model catalog for Freebuff/Codebuff.
 * Fetches live model list from the backend — no hardcoded models.
 * Follows pi-windsurf pattern: catalog is single source of truth.
 */

import * as crypto from "crypto";
import { buildFreebuffMessage, buildJsonRpcRequest, parseFreebuffMessage, type FreebuffEnvelope } from "./wire";

// Use native WebSocket (Node 22+)
const WS = globalThis.WebSocket;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ModelFeatures {
  supportsThinking?: boolean;
  supportsToolCalls?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsImageCaptions?: boolean;
}

export interface ModelCatalogEntry {
  modelUid: string;
  label: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  features?: ModelFeatures;
  isFree: boolean;
  isThinking: boolean;
}

// ----------------------------------------------------------------------------
// Catalog cache
// ----------------------------------------------------------------------------

interface CacheEntry {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
  apiKey: string;
  backendUrl: string;
}

const CATALOG_TTL_MS = 10 * 60 * 1000;

let cached: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;
let inFlightKey: string | null = null;

function flightKey(apiKey: string, backendUrl: string): string {
  return `${backendUrl}\x1f${apiKey}`;
}

// ----------------------------------------------------------------------------
// Dynamic catalog fetch via WebSocket
// ----------------------------------------------------------------------------

async function fetchCatalog(
  apiKey: string,
  backendUrl: string,
  signal?: AbortSignal,
): Promise<CacheEntry> {
  const host = backendUrl.replace(/\/$/, "");
  const wsUrl = host.replace(/^http/, "ws") + "/ws";

  // Connect to backend WebSocket to fetch model list
  const ws = new WS(wsUrl, { headers: { authToken: apiKey } });

  const catalog = await new Promise<CacheEntry>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Catalog fetch timeout"));
    }, 15_000);

    const models = new Map<string, ModelCatalogEntry>();

    ws.addEventListener("open", () => {
      const request = buildFreebuffMessage(
        buildJsonRpcRequest("get_models", { include_disabled: false }),
      );
      ws.send(request);
    });

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const envelope = parseFreebuffMessage(raw);
      if (!envelope) return;

      // Handle model list response
      if (envelope.type === "message" && envelope.message) {
        const msg = envelope.message as Record<string, unknown>;
        if ("result" in msg) {
          const result = msg.result as Record<string, unknown>;
          const modelList = result.models ?? result.data ?? result;
          if (Array.isArray(modelList)) {
            for (const m of modelList) {
              if (m && typeof m === "object") {
                const entry = m as Record<string, unknown>;
                const uid = String(entry.modelUid ?? entry.id ?? entry.uid ?? "");
                const label = String(entry.label ?? entry.name ?? uid);
                if (uid) {
                  models.set(uid, {
                    modelUid: uid,
                    label,
                    provider: String(entry.provider ?? "openrouter"),
                    contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 200_000,
                    maxOutputTokens: typeof entry.maxOutputTokens === "number" ? entry.maxOutputTokens : 16_384,
                    features: entry.features as ModelFeatures | undefined,
                    isFree: Boolean(entry.isFree),
                    isThinking: Boolean(entry.isThinking),
                  });
                }
              }
            }
          }
        }
        // Also handle event-style model list
        if (envelope.type === "event" && envelope.event === "models") {
          const data = envelope.data as Record<string, unknown>;
          const modelList = data?.models ?? data?.data;
          if (Array.isArray(modelList)) {
            for (const m of modelList) {
              if (m && typeof m === "object") {
                const entry = m as Record<string, unknown>;
                const uid = String(entry.modelUid ?? entry.id ?? entry.uid ?? "");
                const label = String(entry.label ?? entry.name ?? uid);
                if (uid) {
                  models.set(uid, {
                    modelUid: uid,
                    label,
                    provider: String(entry.provider ?? "openrouter"),
                    contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 200_000,
                    maxOutputTokens: typeof entry.maxOutputTokens === "number" ? entry.maxOutputTokens : 16_384,
                    features: entry.features as ModelFeatures | undefined,
                    isFree: Boolean(entry.isFree),
                    isThinking: Boolean(entry.isThinking),
                  });
                }
              }
            }
          }
        }
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      ws.close();
      resolve({ byUid: new Map(), fetchedAt: Date.now(), apiKey, backendUrl });
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (models.size > 0) {
        resolve({ byUid: models, fetchedAt: Date.now(), apiKey, backendUrl });
      } else {
        resolve({ byUid: new Map(), fetchedAt: Date.now(), apiKey, backendUrl });
      }
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        ws.close();
        resolve({ byUid: new Map(), fetchedAt: Date.now(), apiKey, backendUrl });
      }, { once: true });
    }
  });

  return catalog;
}

// Fallback catalog from binary analysis (used when backend fetch fails)
function getFallbackCatalog(): ModelCatalogEntry[] {
  return [
    { modelUid: "gpt-4.1-2025-04-14", label: "GPT-4.1", provider: "openai", contextWindow: 1_048_576, maxOutputTokens: 32_768, features: { supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: false },
    { modelUid: "gpt-4o-2024-11-20", label: "GPT-4o", provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: false },
    { modelUid: "gpt-4o-mini-2024-07-18", label: "GPT-4o Mini", provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true, supportsImageCaptions: true }, isFree: true, isThinking: false },
    { modelUid: "o3-2025-04-16", label: "o3", provider: "openai", contextWindow: 200_000, maxOutputTokens: 100_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "o3-mini-2025-01-31", label: "o3 Mini", provider: "openai", contextWindow: 200_000, maxOutputTokens: 100_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "o3-pro-2025-06-10", label: "o3 Pro", provider: "openai", contextWindow: 200_000, maxOutputTokens: 100_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "o4-mini-2025-04-16", label: "o4 Mini", provider: "openai", contextWindow: 200_000, maxOutputTokens: 100_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "gpt-5.1", label: "GPT-5.1", provider: "openai", contextWindow: 1_048_576, maxOutputTokens: 32_768, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "gpt-5.1-chat", label: "GPT-5.1 Chat", provider: "openai", contextWindow: 1_048_576, maxOutputTokens: 32_768, features: { supportsToolCalls: true }, isFree: false, isThinking: false },
    { modelUid: "gpt-5-nano", label: "GPT-5 Nano", provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true }, isFree: true, isThinking: false },
    { modelUid: "gpt-4.1-nano", label: "GPT-4.1 Nano", provider: "openai", contextWindow: 1_048_576, maxOutputTokens: 32_768, features: { supportsToolCalls: true }, isFree: true, isThinking: false },
    { modelUid: "anthropic/claude-3.5-haiku-20241022", label: "Claude 3.5 Haiku", provider: "openrouter", contextWindow: 200_000, maxOutputTokens: 8_192, features: { supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: false },
    { modelUid: "anthropic/claude-3.5-sonnet-20240620", label: "Claude 3.5 Sonnet", provider: "openrouter", contextWindow: 200_000, maxOutputTokens: 8_192, features: { supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: false },
    { modelUid: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1", provider: "openrouter", contextWindow: 200_000, maxOutputTokens: 32_768, features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: true },
    { modelUid: "anthropic/claude-4-sonnet-20250522", label: "Claude 4 Sonnet", provider: "openrouter", contextWindow: 200_000, maxOutputTokens: 16_384, features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: true },
    { modelUid: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", provider: "openrouter", contextWindow: 200_000, maxOutputTokens: 16_384, features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: true },
    { modelUid: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1_048_576, maxOutputTokens: 65_536, features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: true },
    { modelUid: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "openrouter", contextWindow: 1_048_576, maxOutputTokens: 65_536, features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true }, isFree: false, isThinking: true },
    { modelUid: "openai/gpt-5.1", label: "GPT-5.1 (OpenRouter)", provider: "openrouter", contextWindow: 1_048_576, maxOutputTokens: 32_768, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "openai/gpt-4o-2024-11-20", label: "GPT-4o (OpenRouter)", provider: "openrouter", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true }, isFree: false, isThinking: false },
    { modelUid: "openai/gpt-4o-mini-2024-07-18", label: "GPT-4o Mini (OpenRouter)", provider: "openrouter", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true }, isFree: true, isThinking: false },
    { modelUid: "deepseek/deepseek-chat", label: "DeepSeek Chat", provider: "openrouter", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true }, isFree: false, isThinking: false },
    { modelUid: "deepseek/deepseek-r1-0528", label: "DeepSeek R1", provider: "openrouter", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsThinking: true, supportsToolCalls: true }, isFree: false, isThinking: true },
    { modelUid: "kimi/kimi-k2", label: "Kimi K2", provider: "openrouter", contextWindow: 128_000, maxOutputTokens: 16_384, features: { supportsToolCalls: true }, isFree: false, isThinking: false },
  ];
}

// ----------------------------------------------------------------------------
// Catalog API
// ----------------------------------------------------------------------------

export async function getCachedCatalog(
  apiKey: string,
  backendUrl: string,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  const now = Date.now();
  if (cached && cached.apiKey === apiKey && cached.backendUrl === backendUrl) {
    if (now - cached.fetchedAt < CATALOG_TTL_MS) return cached;
  }

  const key = flightKey(apiKey, backendUrl);
  if (inFlight && inFlightKey === key) {
    try { return await inFlight; } catch { return null; }
  }

  const promise = fetchCatalog(apiKey, backendUrl, signal);
  inFlight = promise;
  inFlightKey = key;
  try {
    const result = await promise;
    // If backend returned empty, use fallback
    if (result.byUid.size === 0) {
      console.error("[freebuff] backend catalog empty, using fallback");
      const fallback = getFallbackCatalog();
      const byUid = new Map<string, ModelCatalogEntry>();
      for (const entry of fallback) byUid.set(entry.modelUid, entry);
      result.byUid = byUid;
    }
    cached = result;
    return result;
  } catch {
    return null;
  } finally {
    if (inFlight === promise) {
      inFlight = null;
      inFlightKey = null;
    }
  }
}

export function clearCachedCatalog(): void {
  cached = null;
  inFlight = null;
  inFlightKey = null;
}

export function getCatalogEntry(modelUid: string): ModelCatalogEntry | undefined {
  return cached?.byUid.get(modelUid);
}

export function getAllModels(): ModelCatalogEntry[] {
  if (cached) return [...cached.byUid.values()];
  return getFallbackCatalog();
}

export function getCanonicalModelIds(): string[] {
  return getAllModels().map((m) => m.modelUid);
}
