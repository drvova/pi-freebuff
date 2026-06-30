/**
 * Freebuff Provider for Pi
 *
 * Enables Freebuff/Codebuff models via cloud-direct REST API.
 * Auth via device code flow at freebuff.com.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { startProxy, stopProxy, PROXY_SECRET, setProxyCredentials } from "./proxy";
import { loadCredentials, saveCredentials, deleteCredentials, DEFAULT_REGION, runLoginLoopback, type PersistedCredentials } from "./oauth";
import { clearSessionIds } from "./chat";
import { getAllModels, getCachedCatalog, clearCachedCatalog, type ModelCatalogEntry } from "./catalog";

let _pi: ExtensionAPI | null = null;

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

async function buildDynamicModels(apiKey: string): Promise<ReturnType<typeof catalogModelToPi>[]> {
  try {
    const catalog = await getCachedCatalog(apiKey);
    if (catalog && catalog.byUid.size > 0) {
      const models = [...catalog.byUid.values()].filter((m) => !m.disabled).map(catalogModelToPi);
      console.error(`[freebuff] loaded ${models.length} models from catalog`);
      return models;
    }
  } catch (e) {
    console.error(`[freebuff] catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return getAllModels().map(catalogModelToPi);
}

async function loginFreebuff(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const result = await runLoginLoopback(DEFAULT_REGION, (url) => callbacks.onAuth({ url }));
  const creds: PersistedCredentials = {
    apiKey: result.authToken,
    name: result.user.name,
    email: result.user.email,
    apiServerUrl: DEFAULT_REGION.api,
    backendUrl: DEFAULT_REGION.api,
    issuedAt: new Date().toISOString(),
    fingerprintId: "",
    fingerprintHash: "",
  };
  saveCredentials(creds);
  setProxyCredentials({ apiKey: result.authToken });
  clearSessionIds();
  return { refresh: result.authToken, access: result.authToken, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
}

async function refreshFreebuffToken(c: OAuthCredentials): Promise<OAuthCredentials> { return c; }

export default async function (pi: ExtensionAPI) {
  _pi = pi;

  const proxyPort = await startProxy();
  const baseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  let hasCreds = false;
  let apiKey = "";
  try {
    const stored = loadCredentials();
    if (stored) {
      setProxyCredentials({ apiKey: stored.apiKey });
      hasCreds = true;
      apiKey = stored.apiKey;
    }
  } catch {}

  const fallbackModels = getAllModels().map(catalogModelToPi);
  pi.registerProvider("freebuff", {
    name: "Freebuff (Codebuff)",
    baseUrl,
    apiKey: PROXY_SECRET,
    api: "openai-completions",
    authHeader: true,
    models: fallbackModels,
    oauth: {
      name: "Freebuff (Codebuff)",
      login: loginFreebuff,
      refreshToken: refreshFreebuffToken,
      getApiKey: (creds: OAuthCredentials) => creds.access,
    },
  });

  if (hasCreds) {
    buildDynamicModels(apiKey).then((liveModels) => {
      if (liveModels.length > 0) console.error(`[freebuff] catalog: ${liveModels.length} models (restart to use)`);
    }).catch(() => {});
  }

  console.error(hasCreds ? `[freebuff] connected — ${fallbackModels.length} models` : `[freebuff] /freebuff-login to connect`);

  pi.registerCommand("freebuff-status", {
    description: "Show Freebuff auth status",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) { ctx.ui.notify("Freebuff: not signed in. /freebuff-login", "warning"); return; }
      ctx.ui.notify(`Freebuff: ${c.name} (${c.email}) | Token: ${c.apiKey.slice(0, 8)}...`, "info");
    },
  });

  pi.registerCommand("freebuff-logout", {
    description: "Sign out of Freebuff",
    handler: async (_args, ctx) => {
      deleteCredentials();
      setProxyCredentials(null);
      clearSessionIds();
      ctx.ui.notify("Freebuff: signed out.", "info");
    },
  });

  pi.registerCommand("freebuff-refresh", {
    description: "Refresh Freebuff model catalog",
    handler: async (_args, ctx) => {
      try {
        clearCachedCatalog();
        const c = loadCredentials();
        if (c) {
          const models = await buildDynamicModels(c.apiKey);
          ctx.ui.notify(`Freebuff: refreshed ${models.length} models. Restart Pi to apply.`, "info");
        } else {
          ctx.ui.notify("Freebuff: not signed in. /freebuff-login", "warning");
        }
      } catch (e) {
        ctx.ui.notify(`Freebuff: refresh error — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => { _pi = null; stopProxy(); });
}
