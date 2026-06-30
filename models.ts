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

let cachedCatalog: Awaited<ReturnType<typeof getCachedCatalog>> | null = null;

export function setCatalog(c: Awaited<ReturnType<typeof getCachedCatalog>>): void {
  cachedCatalog = c;
}

export async function resolveModel(
  modelName: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ResolvedModel> {
  const entry = getCatalogEntry(modelName);
  if (entry) return { modelId: modelName, modelUid: entry.modelUid, provider: entry.provider, entry };

  const lower = modelName.toLowerCase();
  const catalog = await getCachedCatalog(apiKey, signal);
  if (catalog) {
    for (const [uid, e] of catalog.byUid) {
      if (uid.toLowerCase() === lower || e.label.toLowerCase() === lower) {
        return { modelId: modelName, modelUid: uid, provider: e.provider, entry: e };
      }
    }
  }
  return { modelId: modelName, modelUid: modelName, provider: "unknown", entry: undefined };
}

export function getDefaultModel(): string {
  return "deepseek/deepseek-v4-pro";
}
