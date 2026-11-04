# TeleBot

A private Telegram LLM bot using Telegraf and the OpenAI Chat Completions SDK. It supports OpenAI and compatible providers through environment variables.

## Features

- Private-user allowlist; the bot refuses to start if `ALLOWED_USERS` is missing.
- Private chats only by default. Group usage must be explicitly enabled.
- Separate conversation memory for each Telegram user and chat.
- Automatic history trimming, session expiration, and an in-memory session limit.
- `/reset`, `/status`, and `/help` commands.
- Long replies are split into Telegram-safe messages.
- API timeout/retry configuration and generic user-facing errors.
- `/health` endpoint for Railway deployment health checks.
- Graceful shutdown on `SIGINT` and `SIGTERM`.

## Required environment variables

| Variable | Description |
| --- | --- |
| `TELEGRAM_TOKEN` | Token from Telegram BotFather. |
| `API_KEY` | API key for your model provider. `OPENAI_API_KEY` is accepted as a fallback. |
| `ALLOWED_USERS` | Comma-separated numeric Telegram user IDs allowed to use the bot. If empty, all users are denied. |

## Provider configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL. |
| `MODEL` | `gpt-4o-mini` | Model name understood by your provider. |
| `SYSTEM_PROMPT` | Built-in concise assistant prompt | System instruction for the bot. |
| `MAX_TOKENS` | `0` | Optional output cap; `0` leaves the provider default. |

## Memory and limits

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_INPUT_CHARS` | `12000` | Maximum incoming text length. |
| `MAX_HISTORY_MESSAGES` | `20` | Maximum number of prior user/assistant messages retained. |
| `MAX_CONTEXT_CHARS` | `30000` | Approximate character budget for prior conversation history. |
| `SESSION_TTL_HOURS` | `12` | Idle time before a conversation expires. |
| `MAX_SESSIONS` | `500` | Maximum number of active in-memory sessions. |
| `ALLOW_GROUPS` | `false` | Set to `true` to allow approved users to use the bot in groups. |

Memory is stored in process memory, not a database. It is isolated by Telegram chat and user, but it is cleared whenever the service restarts or redeploys. Add persistent storage only when you need conversations to survive restarts.

## API reliability

| Variable | Default | Description |
| --- | --- | --- |
| `API_TIMEOUT_MS` | `90000` | Request timeout in milliseconds. |
| `API_MAX_RETRIES` | `2` | SDK retry count for transient request failures. |

## Run locally

1. Install Node.js 22 or newer.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env` and fill in the required values.
4. Run `npm start`.

The process listens on `PORT` (default `3000`). `GET /health` returns success after Telegram polling has started.

## Deploy on Railway

1. Connect this GitHub repository to a Railway service.
2. Add `TELEGRAM_TOKEN`, `API_KEY`, `BASE_URL`, `MODEL`, and `ALLOWED_USERS` in the service Variables tab. Add optional variables only when needed.
3. Use `npm start` as the Start Command (Railway can also detect the package start script).
4. Set the service Healthcheck Path to `/health`.
5. Keep the service at **one replica**. This bot uses Telegram long polling; multiple replicas can compete for the same bot updates.
6. Do not configure a cron schedule for this service. It is a continuously running bot process.

## Telegram user ID

Use a Telegram ID helper bot such as `@userinfobot` to find your numeric user ID, then put it in `ALLOWED_USERS`. Separate multiple IDs with commas.

## Commands

- `/start` — bot introduction.
- `/help` — command list.
- `/reset` — clear the current chat's conversation memory.
- `/status` — model, current session size, active sessions, and successful request count.
