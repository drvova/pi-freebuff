/**
 * Freebuff Provider for Pi
 *
 * Enables Freebuff/Codebuff models via cloud-direct API.
 * Models are fetched from static catalog based on binary analysis.
 *
 * Usage: /freebuff-login → /model freebuff/<id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { startProxy, stopProxy, PROXY_SECRET, setProxyCredentials } from "./proxy";
import { loadCredentials, saveCredentials, deleteCredentials, DEFAULT_REGION, runLoginLoopback, registerUser, type PersistedCredentials } from "./oauth";
import { clearCachedToken } from "./auth";
import { clearSessionIds } from "./chat";
import { getAllModels, getCachedCatalog, clearCachedCatalog, type ModelCatalogEntry } from "./catalog";

let _pi: ExtensionAPI | null = null;

/** Build a Pi model definition from a catalog entry. */
function catalogModelToPi(m: ModelCatalogEntry) {
  const ctx = m.contextWindow ?? 0;
  const maxOut = m.maxOutputTokens ?? 0;
  const tags: string[] = [];
  if (m.isFree) tags.push("Free");
  if (m.isThinking) tags.push("Thinking");
  const tagStr = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  const ctxStr = ctx > 0 ? ` (${ctx >= 1_000_000 ? `${Math.round(ctx / 1_000_000)}M` : `${Math.round(ctx / 1_000)}K`})` : "";
  return {
    id: m.modelUid,
    name: `${m.label}${tagStr}${ctxStr}`,
    reasoning: m.features?.supportsThinking ?? false,
    input: ["text", ...(m.features?.supportsImageCaptions !== false ? ["image"] : [])] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx || 1,
    maxTokens: maxOut || 1,
  };
}

/** Build dynamic model list from catalog. */
async function buildDynamicModels(apiKey: string, backendUrl: string): Promise<ReturnType<typeof catalogModelToPi>[]> {
  try {
    // Fetch live catalog from backend
    const catalog = await getCachedCatalog(apiKey, backendUrl);
    if (catalog && catalog.byUid.size > 0) {
      const models = [...catalog.byUid.values()]
        .filter((m) => !m.disabled)
        .map(catalogModelToPi);
      console.error(`[freebuff] loaded ${models.length} models from catalog`);
      return models;
    }
    // Fallback to static list
    const fallback = getAllModels().map(catalogModelToPi);
    console.error(`[freebuff] using fallback catalog: ${fallback.length} models`);
    return fallback;
  } catch (e) {
    console.error(`[freebuff] catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return getAllModels().map(catalogModelToPi);
  }
}

// OAuth
async function loginFreebuff(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let token: string;
  try {
    token = await runLoginLoopback(DEFAULT_REGION, (url) => callbacks.onAuth({ url }));
  } catch {
    const pasted = await callbacks.onPrompt({
      message: `Open this URL, sign in, paste callback URL or token:\n\n  ${DEFAULT_REGION.website}\n\nPaste:`,
    });
    const trimmed = pasted.trim();
    try {
      const u = new URL(trimmed);
      token = u.searchParams.get("token") ?? u.searchParams.get("authToken") ?? trimmed;
    } catch {
      token = trimmed;
    }
  }
  if (!token) throw new Error("No token received.");

  const result = await registerUser(token, DEFAULT_REGION);
  saveCredentials({ ...result, issuedAt: new Date().toISOString(), oauthClientId: DEFAULT_REGION.oauthClientId });
  setProxyCredentials({ apiKey: result.apiKey, backendUrl: result.backendUrl });
  clearCachedToken();
  clearSessionIds();
  return { refresh: result.apiKey, access: result.apiKey, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
}

async function refreshFreebuffToken(c: OAuthCredentials): Promise<OAuthCredentials> { return c; }

// Extension entry
export default async function (pi: ExtensionAPI) {
  _pi = pi;

  const proxyPort = await startProxy();
  const baseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  let hasCreds = false;
  let apiKey = "";
  let backendUrl = DEFAULT_REGION.backendUrl;
  try {
    const stored = loadCredentials();
    if (stored) {
      setProxyCredentials({ apiKey: stored.apiKey, backendUrl: stored.backendUrl });
      hasCreds = true;
      apiKey = stored.apiKey;
      backendUrl = stored.backendUrl;
    }
  } catch {}

  // Build models dynamically from catalog
  const models = hasCreds ? await buildDynamicModels(apiKey, backendUrl) : getAllModels().map(catalogModelToPi);

  pi.registerProvider("freebuff", {
    name: "Freebuff (Codebuff)",
    baseUrl,
    apiKey: PROXY_SECRET,
    api: "openai-completions",
    authHeader: true,
    models,
    oauth: {
      name: "Freebuff (Codebuff)",
      login: loginFreebuff,
      refreshToken: refreshFreebuffToken,
      getApiKey: (creds: OAuthCredentials) => creds.access,
    },
  });

  console.error(hasCreds ? `[freebuff] connected — ${models.length} models` : `[freebuff] /freebuff-login to connect`);

  pi.registerCommand("freebuff-status", {
    description: "Show Freebuff auth status",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) {
        ctx.ui.notify("Freebuff: not signed in. /freebuff-login", "warning");
        return;
      }
      try {
        const parts: string[] = [];
        parts.push(`API Server: ${c.apiServerUrl}`);
        parts.push(`Backend: ${c.backendUrl}`);
        parts.push(`Token: ${c.apiKey.slice(0, 8)}...`);
        parts.push(`Issued: ${c.issuedAt}`);
        ctx.ui.notify(`Freebuff: ${parts.join(" | ")}`, "info");
      } catch (e) {
        ctx.ui.notify(`Freebuff: authenticated but status check failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    },
  });

  pi.registerCommand("freebuff-logout", {
    description: "Sign out of Freebuff",
    handler: async (_args, ctx) => {
      const ok = deleteCredentials();
      setProxyCredentials(null);
      clearCachedToken();
      clearSessionIds();
      ctx.ui.notify(ok ? "Freebuff: signed out." : "Already signed out.", "info");
    },
  });

  pi.registerCommand("freebuff-refresh", {
    description: "Refresh Freebuff model catalog",
    handler: async (_args, ctx) => {
      try {
        clearCachedCatalog();
        const c = loadCredentials();
        if (c) {
          const models = await buildDynamicModels(c.apiKey, c.backendUrl);
          ctx.ui.notify(`Freebuff: refreshed ${models.length} models. Restart Pi to apply.`, "info");
        } else {
          ctx.ui.notify("Freebuff: not signed in. /freebuff-login", "warning");
        }
      } catch (e) {
        ctx.ui.notify(`Freebuff: refresh error - ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => { _pi = null; stopProxy(); });
}
