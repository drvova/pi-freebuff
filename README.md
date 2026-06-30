<p align="center">
  <img src="https://github.com/drvova/pi-mcp-deferred/raw/master/pi-logo-animated.svg" alt="pi-freebuff" width="200">
</p>

<h1 align="center">pi-freebuff</h1>

<p align="center">Use Freebuff/Codebuff models in <a href="https://github.com/earendil-works/pi">Pi</a> — DeepSeek, Kimi, MiniMax, Claude, GPT, Gemini, and more. All via your existing Freebuff subscription. No separate API keys.</p>

## How it works

Runs a local proxy at `127.0.0.1:42101` that speaks standard OpenAI Chat Completions API. Translates requests to Freebuff's proprietary JSON-RPC 2.0 wire format over WebSocket. Pi talks to the proxy via `api: "openai-completions"` — no custom streaming code needed.

**Cloud-direct mode** talks straight to Freebuff's servers over WebSocket. No IDE installation, no background processes. The local proxy adds negligible overhead.

```
Pi → proxy (localhost:42101) → Freebuff Cloud
```

## Install

**Option A — Git (recommended):**

```bash
pi install git:github.com/drvova/pi-freebuff
```

**Option B — npm:**

```bash
pi install npm:pi-freebuff
```

**Option C — Local dev:**

```bash
git clone https://github.com/drvova/pi-freebuff.git ~/developer/pi-freebuff
pi -e ~/developer/pi-freebuff/index.ts
```

## Setup

### 1. Sign in

```
/freebuff-login
```

Browser opens to codebuff.com. Sign in with your Freebuff account. Token captured automatically.

### 2. Pick a model

```
/model freebuff/<model-id>
```

Models shown are whatever your Freebuff plan enables.

### 3. Chat

Use Pi as normal. Your Freebuff subscription covers API costs.

## Commands

| Command | Does |
|---------|------|
| `/freebuff-login` | Sign in (browser-based OAuth) |
| `/freebuff-status` | Show auth state |
| `/freebuff-logout` | Sign out |
| `/freebuff-refresh` | Refresh model list |

## How models work

Models are loaded from a static catalog based on binary analysis of the Freebuff/Codebuff CLI. The catalog includes:

### OpenAI Models (Direct)
- GPT-4.1, GPT-4o, GPT-4o Mini
- o3, o3 Mini, o3 Pro

### Anthropic Models (via OpenRouter)
- Claude 3.5 Haiku, Claude 3.5 Sonnet
- Claude Opus 4.1, Claude 4 Sonnet, Claude Sonnet 4.5

### Google Models (via OpenRouter)
- Gemini 2.5 Flash, Gemini 2.5 Pro

### OpenAI GPT-5 Models (via OpenRouter)
- GPT-5.1, GPT-5.1 Chat
- GPT-4o, GPT-4o Mini, o3 Mini (OpenRouter variants)
- GPT-4.1 Nano

### Model Tags

- **[Free]** — no pricing info = free on your plan
- **[Thinking]** — supports extended thinking/reasoning

### Zero hardcoding

- No hardcoded model lists — catalog is defined statically
- New models can be added by editing `catalog.ts`

## Endpoints

All traffic goes to `manicode-backend.onrender.com`:

| Endpoint | Purpose |
|----------|---------|
| `POST /ws` | WebSocket JSON-RPC 2.0 streaming |
| `GET /api/auth/cli/status` | Check auth status |
| `POST /api/auth/cli/code` | Initiate CLI login |

## Files

```
index.ts       Pi extension entry (provider registration + model building)
proxy.ts       HTTP server (OpenAI API → JSON-RPC translation)
chat.ts        WebSocket streaming (JSON-RPC encode/decode, SSE events)
wire.ts        JSON-RPC 2.0 message builders
catalog.ts     Static model catalog from binary analysis
models.ts      Model resolution
auth.ts        Token management
metadata.ts    WebSocket metadata builder
oauth.ts       Login loopback + RegisterUser
```

## Requirements

- Pi (any recent version)
- Node.js >= 18 or Bun
- Freebuff account (free or paid)

No npm dependencies. Uses only Node built-ins and Pi's own types.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    PI-FREEBUFF ARCHITECTURE                       │
│                                                                    │
│  ┌─────────┐  HTTP /v1/chat/completions  ┌────────────────────┐  │
│  │    Pi    │ ──────────────────────────> │   Local Proxy      │  │
│  │ (coding  │ <────────────────────────── │   127.0.0.1:42101  │  │
│  │  agent)  │       SSE streaming         │                    │  │
│  └─────────┘                              │  proxy.ts          │  │
│                                            │  chat.ts           │  │
│                                            │  wire.ts           │  │
│                                            └────────┬───────────┘  │
│                                                     │              │
│                                            JSON-RPC 2.0 over WS   │
│                                                     │              │
│                                                     v              │
│                                            ┌──────────────────┐  │
│                                            │ manicode-backend  │  │
│                                            │ .onrender.com     │  │
│                                            └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## License

MIT
