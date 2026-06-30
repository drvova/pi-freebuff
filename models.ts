/**
 * Model resolution — catalog is the single source of truth.
 */

import { getCachedCatalog, getCatalogEntry, type ModelCatalogEntry } from "./catalog";

export interface ResolvedModel {
  modelId: string;
  modelUid: string;
  provider: string;
  entry: ModelCatalogEntry | undefined;
}

// Cached catalog reference (set by proxy after fetch)
let cachedCatalog: Awaited<ReturnType<typeof getCachedCatalog>> | null = null;

export function setCatalog(c: Awaited<ReturnType<typeof getCachedCatalog>>): void {
  cachedCatalog = c;
}

export async function resolveModel(
  modelName: string,
  apiKey: string,
  backendUrl: string,
  signal?: AbortSignal,
): Promise<ResolvedModel> {
  const entry = getCatalogEntry(modelName);
  if (entry) return { modelId: modelName, modelUid: entry.modelUid, provider: entry.provider, entry };

  const lower = modelName.toLowerCase();
  const catalog = await getCachedCatalog(apiKey, backendUrl, signal);
  if (catalog) {
    for (const [uid, e] of catalog.byUid) {
      if (uid.toLowerCase() === lower || e.label.toLowerCase() === lower) {
        return { modelId: modelName, modelUid: uid, provider: e.provider, entry: e };
      }
    }
  }
  return { modelId: modelName, modelUid: modelName, provider: "openrouter", entry: undefined };
}

export function resolveModelSync(modelName: string): ResolvedModel {
  const entry = getCatalogEntry(modelName);
  if (entry) return { modelId: modelName, modelUid: entry.modelUid, provider: entry.provider, entry };

  const lower = modelName.toLowerCase();
  if (cachedCatalog) {
    for (const [uid, e] of cachedCatalog.byUid) {
      if (uid.toLowerCase() === lower || e.label.toLowerCase() === lower) {
        return { modelId: modelName, modelUid: uid, provider: e.provider, entry: e };
      }
    }
  }
  return { modelId: modelName, modelUid: modelName, provider: "openrouter", entry: undefined };
}

export function getDefaultModel(): string {
  if (cachedCatalog?.byUid && cachedCatalog.byUid.size > 0) {
    const first = cachedCatalog.byUid.values().next().value;
    if (first) return first.modelUid;
  }
  return "anthropic/claude-4-sonnet-20250522";
}

export function getCanonicalModels(): string[] {
  return [];
}
