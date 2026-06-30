/**
 * Dynamic model catalog for Freebuff.
 * Fetches live model list from Codebuff's free-agents.ts source file.
 * No hardcoded fallback — if the fetch fails, no models are available.
 */

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

const FREE_AGENTS_SOURCE_URL =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts";

// ---- Known model variable mappings (from free-agents.ts) ----

const KNOWN_MODEL_VARS: Record<string, string> = {
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID: "deepseek/deepseek-v4-pro",
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID: "deepseek/deepseek-v4-flash",
  FREEBUFF_GEMINI_PRO_MODEL_ID: "google/gemini-3.1-pro-preview",
  FREEBUFF_KIMI_MODEL_ID: "moonshotai/kimi-k2.6",
  FREEBUFF_MINIMAX_MODEL_ID: "minimax/minimax-m2.7",
  FREEBUFF_MINIMAX_M3_MODEL_ID: "minimax/minimax-m3",
  FREEBUFF_MIMO_V25_MODEL_ID: "mimo/mimo-v2.5",
  FREEBUFF_MIMO_V25_PRO_MODEL_ID: "mimo/mimo-v2.5-pro",
};

const KNOWN_MODEL_SETS: Record<string, string[]> = {
  FREEBUFF_ALLOWED_MODEL_IDS: [
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "moonshotai/kimi-k2.6",
    "minimax/minimax-m2.7",
    "minimax/minimax-m3",
    "mimo/mimo-v2.5",
    "mimo/mimo-v2.5-pro",
  ],
};

// ---- Parsing ----

function extractModelsFromSource(source: string): string[] {
  const models = new Set<string>();

  // Pattern 1: 'model-id': new Set([...])
  const literalRe = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g;
  let match: RegExpExecArray | null;
  while ((match = literalRe.exec(source)) !== null) {
    const inner = match[2];
    const modelRe = /'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(inner)) !== null) {
      const model = m[1].trim();
      if (model) models.add(model);
    }
    for (const [varName, modelId] of Object.entries(KNOWN_MODEL_VARS)) {
      if (inner.includes(varName)) models.add(modelId);
    }
  }

  // Pattern 2: 'agent-id': new Set(VARIABLE_NAME)
  const refRe = /'([^']+)':\s*new\s+Set\((\w+)\)/g;
  while ((match = refRe.exec(source)) !== null) {
    const varName = match[2];
    const knownModels = KNOWN_MODEL_SETS[varName];
    if (knownModels) knownModels.forEach((m) => models.add(m));
    const modelId = KNOWN_MODEL_VARS[varName];
    if (modelId) models.add(modelId);
  }

  return [...models].sort();
}

// ---- Catalog cache ----

interface CacheEntry {
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
}

const CATALOG_TTL_MS = 6 * 3600_000;
let cached: CacheEntry | null = null;

function modelToEntry(modelUid: string): ModelCatalogEntry {
  const provider = modelUid.includes("/") ? modelUid.split("/")[0] : "unknown";
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

// ---- Catalog API ----

export async function getCachedCatalog(
  apiKey: string,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) return cached;

  try {
    const response = await fetch(FREE_AGENTS_SOURCE_URL, {
      signal: signal ?? AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      const source = await response.text();
      const modelIds = extractModelsFromSource(source);
      if (modelIds.length > 0) {
        const byUid = new Map<string, ModelCatalogEntry>();
        for (const id of modelIds) byUid.set(id, modelToEntry(id));
        cached = { byUid, fetchedAt: now };
        console.error(`[freebuff] catalog: fetched ${modelIds.length} models from source`);
        return cached;
      }
    }
  } catch (e) {
    console.error(`[freebuff] catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return null;
}

export function clearCachedCatalog(): void { cached = null; }
export function getCatalogEntry(modelUid: string): ModelCatalogEntry | undefined { return cached?.byUid.get(modelUid); }
export function getAllModels(): ModelCatalogEntry[] {
  if (cached) return [...cached.byUid.values()];
  return [];
}
