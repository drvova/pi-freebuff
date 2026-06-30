/**
 * Model catalog for Freebuff.
 * Fetches live from Codebuff's open-source freebuff-models.ts:
 * https://github.com/CodebuffAI/codebuff/blob/main/common/src/constants/freebuff-models.ts
 *
 * Uses curl via child_process — Node's https module times out in the Pi runtime,
 * but curl (system binary, different TLS/DNS stack) works fine.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---- Types ----

export interface ModelCatalogEntry {
  modelUid: string;
  label: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  features?: { supportsThinking?: boolean; supportsToolCalls?: boolean; supportsImageCaptions?: boolean };
  isFree: boolean;
  isThinking: boolean;
  disabled?: boolean;
}

// ---- Source URL ----

const FREE_MODELS_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts";

// ---- Known model variable mappings (from freebuff-models.ts) ----

const KNOWN_MODEL_VARS: Record<string, string> = {
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID: "deepseek/deepseek-v4-pro",
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID: "deepseek/deepseek-v4-flash",
  FREEBUFF_GEMINI_PRO_MODEL_ID: "google/gemini-3.1-pro-preview",
  FREEBUFF_KIMI_MODEL_ID: "moonshotai/kimi-k2.6",
  FREEBUFF_MINIMAX_MODEL_ID: "minimax/minimax-m2.7",
  FREEBUFF_MINIMAX_M3_MODEL_ID: "minimax/minimax-m3",
  FREEBUFF_MIMO_V25_MODEL_ID: "mimo/mimo-v2.5",
  FREEBUFF_MIMO_V25_PRO_MODEL_ID: "mimo/mimo-v2.5-pro",
  FREEBUFF_GLM_V52_MODEL_ID: "z-ai/glm-5.2",
};

// ---- Fetch via curl ----

function curlGet(url: string): string {
  return execSync(`curl -sL --max-time 15 '${url}'`, { encoding: "utf8", timeout: 20_000 });
}

// ---- Parsing ----

function extractModelsFromSource(source: string): string[] {
  const models = new Set<string>();

  // Pattern 1: export const FREEBUFF_*_MODEL_ID = 'model-id'
  const exportRe = /export\s+const\s+(FREEBUFF_\w+_MODEL_ID)\s*=\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = exportRe.exec(source)) !== null) {
    const value = match[2].trim();
    if (value.includes("/") && !value.startsWith("minimaxModels") && !value.startsWith("mimoModels") && !value.startsWith("fireworks/")) {
      KNOWN_MODEL_VARS[match[1]] = value;
      models.add(value);
    }
  }

  // Pattern 2: id: FREEBUFF_*_MODEL_ID — variable refs in object literals
  const idRe = /id:\s*(FREEBUFF_\w+_MODEL_ID)/g;
  while ((match = idRe.exec(source)) !== null) {
    const modelId = KNOWN_MODEL_VARS[match[1]];
    if (modelId) models.add(modelId);
  }

  // Pattern 3: [VARIABLE]: 'agent-id'
  const reverseRe = /\[([A-Z_]+)\]:\s*'([^']+)'/g;
  while ((match = reverseRe.exec(source)) !== null) {
    const modelId = KNOWN_MODEL_VARS[match[1]];
    if (modelId) models.add(modelId);
  }

  // Pattern 4: 'model-id': new Set([...])
  const literalRe = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g;
  while ((match = literalRe.exec(source)) !== null) {
    const inner = match[2];
    const modelRe = /'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(inner)) !== null) {
      const model = m[1].trim();
      if (model && !model.startsWith("fireworks/")) models.add(model);
    }
    for (const [varName, modelId] of Object.entries(KNOWN_MODEL_VARS)) {
      if (inner.includes(varName)) models.add(modelId);
    }
  }

  return [...models].sort();
}

// ---- Disk cache (persists across restarts) ----

interface DiskCache {
  models: string[];
  fetchedAt: number;
}

const DISK_CACHE_TTL_MS = 6 * 3600_000;

function getDiskCachePath(): string {
  return path.join(os.homedir(), ".config", "pi-freebuff", "models.json");
}

function loadDiskCache(): DiskCache | null {
  try {
    const p = getDiskCachePath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as DiskCache;
    if (Date.now() - data.fetchedAt < DISK_CACHE_TTL_MS && data.models.length > 0) return data;
  } catch {}
  return null;
}

function saveDiskCache(models: string[]): void {
  try {
    const dir = path.dirname(getDiskCachePath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(getDiskCachePath(), JSON.stringify({ models, fetchedAt: Date.now() }), { mode: 0o600 });
  } catch {}
}

// ---- Memory cache ----

interface CacheEntry {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
}

let cached: CacheEntry | null = null;

function modelToEntry(modelUid: string): ModelCatalogEntry {
  const provider = modelUid.split("/")[0];
  const label = modelUid.split("/").pop() ?? modelUid;
  return {
    modelUid,
    label,
    provider,
    contextWindow: 195_000,
    maxOutputTokens: 60_000,
    features: { supportsThinking: true, supportsToolCalls: true, supportsImageCaptions: true },
    isFree: true,
    isThinking: true,
  };
}

function buildCache(modelIds: string[]): CacheEntry {
  const byUid = new Map<string, ModelCatalogEntry>();
  for (const id of modelIds) byUid.set(id, modelToEntry(id));
  return { byUid, fetchedAt: Date.now() };
}

// ---- Catalog API ----

export async function getCachedCatalog(
  _apiKey: string,
  _signal?: AbortSignal,
): Promise<CacheEntry | null> {
  // 1. Memory cache
  if (cached) return cached;

  // 2. Disk cache
  const disk = loadDiskCache();
  if (disk) {
    cached = buildCache(disk.models);
    console.error(`[freebuff] catalog: loaded ${disk.models.length} models from disk cache`);
    return cached;
  }

  // 3. Fetch from source via curl
  try {
    console.error("[freebuff] catalog: fetching from source via curl...");
    const source = curlGet(FREE_MODELS_SOURCE_URL);
    const modelIds = extractModelsFromSource(source);
    if (modelIds.length > 0) {
      cached = buildCache(modelIds);
      saveDiskCache(modelIds);
      console.error(`[freebuff] catalog: fetched ${modelIds.length} models: ${modelIds.join(", ")}`);
      return cached;
    }
    console.error("[freebuff] catalog: no models parsed from source");
  } catch (e) {
    console.error(`[freebuff] catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return null;
}

export function clearCachedCatalog(): void {
  cached = null;
  try { fs.unlinkSync(getDiskCachePath()); } catch {}
}

export function getCatalogEntry(modelUid: string): ModelCatalogEntry | undefined {
  return cached?.byUid.get(modelUid);
}

export function getAllModels(): ModelCatalogEntry[] {
  if (cached) return [...cached.byUid.values()];
  return [];
}
