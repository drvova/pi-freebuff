# pi-freebuff

Free AI models (DeepSeek, Kimi, MiniMax, Mimo, Gemini, GLM) in [Pi](https://github.com/earendil-works/pi) via your freebuff.com account.

## Install

```bash
pi install git:github.com/drvova/pi-freebuff
```

## Setup

1. `/freebuff-login` — opens browser, sign in with GitHub
2. `/model` — pick a freebuff model
3. Chat normally

## How it works

Local HTTP proxy on `127.0.0.1:42101` translates OpenAI Chat Completions API → freebuff.com REST API. Handles auth, session lifecycle, run management, and thinking model compatibility.

## Models

Catalog fetched dynamically from [Codebuff's freebuff-models.ts](https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts). Whatever the server makes available:

| Model | Notes |
|-------|-------|
| `deepseek/deepseek-v4-pro` | Thinking model |
| `deepseek/deepseek-v4-flash` | Fast |
| `minimax/minimax-m2.7` | |
| `minimax/minimax-m3` | |
| `moonshotai/kimi-k2.6` | |
| `mimo/mimo-v2.5` | |
| `mimo/mimo-v2.5-pro` | Actually Claude on backend |
| `google/gemini-3.1-pro-preview` | |
| `fireworks/deepseek-v4-flash` | Maps to deepseek-v4-flash |

## Commands

| Command | Does |
|---------|------|
| `/freebuff-login` | Browser-based OAuth |
| `/freebuff-status` | Show auth state |
| `/freebuff-logout` | Sign out |

## Requirements

- Pi (any recent version)
- Node.js >= 18
- freebuff.com account (free)

## License

MIT
