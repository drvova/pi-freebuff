/**
 * Dynamic model catalog for Freebuff.
 * Fetches live model list from the backend REST API.
 */

import { DEFAULT_REGION } from "./oauth";

// ---- Types ----

export interface ModelFeatures {
  supportsThinking?: boolean;
  supportsToolCalls?: boolean;
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
  disabled?: boolean;
}

// ---- Catalog cache ----

interface CacheEntry {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
}

const CATALOG_TTL_MS = 10 * 60 * 1000;
let cached: CacheEntry | null = null;

// ---- Fallback catalog ----

function getFallbackCatalog(): ModelCatalogEntry[] {
  return [
    { modelUid: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "minimax/minimax-m2.7", label: "MiniMax M2.7", provider: "minimax", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "minimax/minimax-m3", label: "MiniMax M3", provider: "minimax", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "mimo/mimo-v2.5", label: "MiMo V2.5", provider: "mimo", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "mimo/mimo-v2.5-pro", label: "MiMo V2.5 Pro", provider: "mimo", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "moonshotai/kimi-k2.6", label: "Kimi K2.6", provider: "moonshotai", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
    { modelUid: "z-ai/glm-5.1", label: "GLM-5.1", provider: "z-ai", contextWindow: 195_000, maxOutputTokens: 60_000, features: { supportsThinking: true, supportsToolCalls: true }, isFree: true, isThinking: true },
  ];
}

// ---- Catalog API ----

export async function getCachedCatalog(
  apiKey: string,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) return cached;

  try {
    const response = await fetch(`${DEFAULT_REGION.api}/api/v1/models`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "User-Agent": "Bun/1.3.11" },
      signal: signal ?? AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = await response.json() as { data?: Array<{ id: string; [key: string]: unknown }> };
      const models = new Map<string, ModelCatalogEntry>();
      const list = data.data ?? [];
      for (const m of list) {
        if (m.id) {
          models.set(m.id, {
            modelUid: m.id,
            label: String(m.id.split("/").pop() ?? m.id),
            provider: m.id.includes("/") ? m.id.split("/")[0] : "unknown",
            contextWindow: typeof m.context_window === "number" ? m.context_window : 195_000,
            maxOutputTokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : 60_000,
            isFree: true,
            isThinking: true,
          });
        }
      }
      if (models.size > 0) {
        cached = { byUid: models, fetchedAt: now };
        return cached;
      }
    }
  } catch {}

  // Fallback
  const fallback = getFallbackCatalog();
  const byUid = new Map<string, ModelCatalogEntry>();
  for (const entry of fallback) byUid.set(entry.modelUid, entry);
  cached = { byUid, fetchedAt: now };
  return cached;
}

export function clearCachedCatalog(): void { cached = null; }
export function getCatalogEntry(modelUid: string): ModelCatalogEntry | undefined { return cached?.byUid.get(modelUid); }
export function getAllModels(): ModelCatalogEntry[] { return getFallbackCatalog(); }
