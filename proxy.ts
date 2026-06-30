/**
 * OpenAI-compatible HTTP proxy → Freebuff REST API.
 * Binds at 127.0.0.1:42101. Accepts /v1/chat/completions and /v1/models.
 */
import * as crypto from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { streamCloudChat, type ChatMessage, type ToolDefinition } from "./chat";
import { resolveModel, getDefaultModel, setCatalog } from "./models";
import { loadCredentials } from "./oauth";
import { getAllModels, getCachedCatalog, type ModelCatalogEntry } from "./catalog";

const FREEBUFF_PROXY_HOST = "127.0.0.1";
const FREEBUFF_PROXY_PORT = 42101;

export const PROXY_SECRET: string = crypto.randomBytes(32).toString("hex");

export let proxyCredentials: { apiKey: string } | null = null;
export function setProxyCredentials(creds: { apiKey: string } | null): void {
  proxyCredentials = creds;
}

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
}

function mapMessage(m: ChatCompletionRequest["messages"][number]): ChatMessage {
  const content: ChatMessage["content"] = typeof m.content === "string"
    ? m.content
    : m.content.map((p) => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image_url") return { type: "image_url", image_url: { url: p.image_url?.url ?? "" } };
        return { type: "text", text: "" };
      });
  return {
    role: m.role as ChatMessage["role"],
    content,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  } as ChatMessage;
}

async function authorizeRequest(req: IncomingMessage): Promise<{ status: number; body: string; contentType: string } | null> {
  const authHeader = (req.headers.authorization ?? "") as string;
  if (!authHeader.startsWith("Bearer ")) {
    return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized.", type: "freebuff_error" } }), contentType: "application/json" };
  }
  const presented = authHeader.slice("Bearer ".length);
  const presentedBuf = Buffer.from(presented, "utf8");
  const secretBuf = Buffer.from(PROXY_SECRET, "utf8");
  if (presentedBuf.length === secretBuf.length && crypto.timingSafeEqual(presentedBuf, secretBuf)) return null;
  if (proxyCredentials?.apiKey) {
    const credBuf = Buffer.from(proxyCredentials.apiKey, "utf8");
    if (presentedBuf.length === credBuf.length && crypto.timingSafeEqual(presentedBuf, credBuf)) return null;
  }
  try {
    const creds = loadCredentials();
    if (creds?.apiKey && creds.apiKey !== proxyCredentials?.apiKey) {
      const credBuf = Buffer.from(creds.apiKey, "utf8");
      if (presentedBuf.length === credBuf.length && crypto.timingSafeEqual(presentedBuf, credBuf)) return null;
    }
  } catch {}
  return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: Invalid Bearer token.", type: "freebuff_error" } }), contentType: "application/json" };
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${FREEBUFF_PROXY_HOST}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const authErr = await authorizeRequest(req);
    if (authErr) {
      res.writeHead(authErr.status, { "Content-Type": authErr.contentType });
      res.end(authErr.body);
      return;
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      let allModels: ModelCatalogEntry[] = [];
      try {
        const creds = loadCredentials() ?? proxyCredentials;
        if (creds) {
          const catalog = await getCachedCatalog(creds.apiKey);
          if (catalog) allModels = [...catalog.byUid.values()];
        }
      } catch {}
      if (allModels.length === 0) allModels = getAllModels();
      if (allModels.length > 0) {
        const data = allModels.map((m) => ({ id: m.modelUid, object: "model" as const, created: Math.floor(Date.now() / 1000), owned_by: "freebuff" }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
      }
      return;
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed; use POST.", type: "freebuff_error" } }));
        return;
      }

      const rawBody = await getBody(req);
      let requestBody: ChatCompletionRequest;
      try { requestBody = JSON.parse(rawBody); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Malformed JSON." } }));
        return;
      }

      if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages must be an array." } }));
        return;
      }

      const diskCreds = loadCredentials();
      const creds = diskCreds ?? proxyCredentials;
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not authenticated. Run /freebuff-login first." } }));
        return;
      }

      const requestedModel = requestBody.model || getDefaultModel();
      const resolved = await resolveModel(requestedModel, creds.apiKey);

      const tools: ToolDefinition[] = (requestBody.tools ?? []).map((t) => ({
        type: "function" as const,
        function: {
          name: t.function?.name ?? "unknown",
          description: t.function?.description ?? "",
          parameters: t.function?.parameters ?? {},
        },
      }));

      const messages: ChatMessage[] = requestBody.messages.map(mapMessage);
      const requestedMaxTokens = typeof requestBody.max_tokens === "number" && requestBody.max_tokens > 0 ? requestBody.max_tokens : 128_000;
      const isStreaming = requestBody.stream !== false;

      if (proxyCredentials) {
        try {
          const catalog = await getCachedCatalog(creds.apiKey);
          if (catalog) setCatalog(catalog);
        } catch {}
      }

      if (isStreaming) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const responseId = `chatcmpl-${crypto.randomUUID()}`;
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });

        try {
          let firstChunkSent = false;
          let toolCallIndex = -1;
          let finishReason: string | null = null;

          const chunk = (delta: Record<string, unknown>) => ({
            id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel,
            choices: [{ index: 0, delta, finish_reason: null }],
          });

          await streamCloudChat({
            apiKey: creds.apiKey,
            modelUid: resolved.modelUid,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            completionOpts: { maxOutputTokens: requestedMaxTokens, temperature: requestBody.temperature },
            signal: abort.signal,
            callbacks: {
              onText: (text) => {
                res.write(`data: ${JSON.stringify(chunk(firstChunkSent ? { content: text } : { role: "assistant", content: text }))}\n\n`);
                firstChunkSent = true;
              },
              onThinking: (text) => {
                res.write(`data: ${JSON.stringify(chunk(firstChunkSent ? { reasoning: text } : { role: "assistant", reasoning: text }))}\n\n`);
                firstChunkSent = true;
              },
              onToolCall: (name, args) => {
                toolCallIndex++;
                const id = `call_${crypto.randomUUID().slice(0, 12)}`;
                const tcObj = { index: toolCallIndex, id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
                res.write(`data: ${JSON.stringify(chunk(firstChunkSent ? { tool_calls: [tcObj] } : { role: "assistant", tool_calls: [tcObj] }))}\n\n`);
                firstChunkSent = true;
              },
              onFinish: (reason) => {
                finishReason = reason;
                res.write(`data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }] })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
              },
              onError: (err) => {
                const msg = err instanceof Error ? err.message : "Unknown error";
                try {
                  res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
                  res.write("data: [DONE]\n\n");
                  res.end();
                } catch {}
              },
            },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          try {
            res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
        }
      } else {
        let collected = "";
        let finishReason = "stop";
        const toolCalls: Array<{ id: string; name: string; args: string }> = [];
        const abort = new AbortController();

        await streamCloudChat({
          apiKey: creds.apiKey,
          modelUid: resolved.modelUid,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          completionOpts: { maxOutputTokens: requestedMaxTokens, temperature: requestBody.temperature },
          signal: abort.signal,
          callbacks: {
            onText: (text) => { collected += text; },
            onToolCall: (name, args) => {
              toolCalls.push({ id: `call_${crypto.randomUUID().slice(0, 12)}`, name, args: typeof args === "string" ? args : JSON.stringify(args) });
            },
            onFinish: (reason) => { finishReason = reason; },
            onError: (err) => { throw err; },
          },
        });

        if (toolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";
        const assistantMessage = toolCalls.length > 0
          ? { role: "assistant" as const, content: collected, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })) }
          : { role: "assistant" as const, content: collected };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: requestedModel,
          choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
        }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unsupported path: ${url.pathname}` } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message } })); } catch {}
  }
}

let serverInstance: ReturnType<typeof createServer> | null = null;

export function startProxy(port: number = FREEBUFF_PROXY_PORT): Promise<number> {
  if (serverInstance) return Promise.resolve((serverInstance.address() as { port: number }).port);
  return new Promise((resolve, reject) => {
    const srv = createServer(handleRequest);
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        srv.listen(0, FREEBUFF_PROXY_HOST, () => { serverInstance = srv; resolve((srv.address() as { port: number }).port); });
        return;
      }
      reject(err);
    });
    srv.listen(port, FREEBUFF_PROXY_HOST, () => { serverInstance = srv; resolve((srv.address() as { port: number }).port); });
  });
}

export function stopProxy(): void {
  if (serverInstance) { try { serverInstance.close(); } catch {} serverInstance = null; }
}
