/**
 * Dynamic model resolution — catalog is the single source of truth.
 * No hardcoded models — everything comes from the catalog.
 */

import { getCachedCatalog, getCatalogEntry, type ModelCatalogEntry } from "./catalog";

export interface ResolvedModel {
  modelId: string;
  modelUid: string;
  provider: string;
  entry: ModelCatalogEntry | undefined;
}

/** Resolve a model name to its catalog entry. Supports aliases. */
export async function resolveModel(
  modelName: string,
  apiKey: string,
  backendUrl: string,
  signal?: AbortSignal,
): Promise<ResolvedModel> {
  // Try exact match first
  let entry = getCatalogEntry(modelName);
  if (entry) {
    return {
      modelId: modelName,
      modelUid: entry.modelUid,
      provider: entry.provider,
      entry,
    };
  }

  // Try case-insensitive match
  const lower = modelName.toLowerCase();
  const catalog = await getCachedCatalog(apiKey, backendUrl, signal);
  if (catalog) {
    for (const [uid, e] of catalog.byUid) {
      if (uid.toLowerCase() === lower || e.label.toLowerCase() === lower) {
        return { modelId: modelName, modelUid: uid, provider: e.provider, entry: e };
      }
    }
  }

  // Pass through as-is — let the backend resolve it
  return {
    modelId: modelName,
    modelUid: modelName,
    provider: "openrouter",
    entry: undefined,
  };
}

/** Synchronous resolve for when catalog is already loaded. */
export function resolveModelSync(modelName: string): ResolvedModel {
  const entry = getCatalogEntry(modelName);
  if (entry) {
    return { modelId: modelName, modelUid: entry.modelUid, provider: entry.provider, entry };
  }

  // Try case-insensitive
  const lower = modelName.toLowerCase();
  const allModels = catalog?.byUid;
  if (allModels) {
    for (const [uid, e] of allModels) {
      if (uid.toLowerCase() === lower || e.label.toLowerCase() === lower) {
        return { modelId: modelName, modelUid: uid, provider: e.provider, entry: e };
      }
    }
  }

  return { modelId: modelName, modelUid: modelName, provider: "openrouter", entry: undefined };
}

// Access cached catalog synchronously
let catalog: Awaited<ReturnType<typeof getCachedCatalog>> | null = null;

export function setCatalog(c: Awaited<ReturnType<typeof getCachedCatalog>>): void {
  catalog = c;
}

export function getDefaultModel(): string {
  // Return first available model or a sensible default
  const models = catalog?.byUid;
  if (models && models.size > 0) {
    const first = models.values().next().value;
    if (first) return first.modelUid;
  }
  return "anthropic/claude-4-sonnet-20250522";
}

export function getCanonicalModels(): string[] {
  return [];
}
