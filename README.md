# puku-proxy

An OpenAI-compatible HTTP proxy built on top of [puku-agent-sdk](https://www.npmjs.com/package/puku-agent-sdk). Exposes the standard `/v1/chat/completions`, `/v1/models`, and `/healthz` endpoints, translating each request into a single puku `query()` call. Any OpenAI client (Open WebUI, LangChain, Continue, etc.) can point at it as `OPENAI_BASE_URL=http://localhost:8787/v1` without knowing about puku.

## Requirements

- [Bun](https://bun.sh) >= 1.4
- `puku-cli` on `$PATH` (install via `npm install -g @puku/puku-cli`)

## Install

```bash
bun install
cp .env.example .env   # optional — see "Auth" below
bun start
```

Server listens on `http://localhost:8787` by default. Override with `PORT=…`.

## Auth

The proxy inherits auth from the environment, exactly as `puku-cli` does:

| Variable           | Effect                                                                  |
|--------------------|-------------------------------------------------------------------------|
| `PUKU_AI_API_KEY`  | Primary API key. Set this for headless / CI usage.                      |
| `PUKU_AUTH_TOKEN`  | OAuth bearer. Alternative to API key.                                   |
| `PUKU_BASE_URL`    | Override the SDK gateway URL (defaults to `https://agent.sdk.puku.sh`). |

If none of these are set, the proxy falls back to whatever `puku-cli auth login` has stored in the keychain, or its anonymous default routing. You can `puku-cli auth login` interactively once and the proxy will pick it up.

## Endpoints

### `GET /healthz`

Liveness probe. Returns `200 {status: "ok", puku_cli: "/path/to/puku-cli", bun: "1.4.2"}` when `puku-cli` is on `$PATH`, `503` otherwise.

### `GET /v1/models`

Returns the OpenAI-shaped model list. Currently advertises `puku-default`, `puku-fast`, `opus`, `sonnet` — adjust in `src/server.ts` as the SDK exposes more.

### `POST /v1/chat/completions`

Accepts an OpenAI-shaped request body. Streams `text/event-stream` chunks when `stream: true`, returns a single JSON `chat.completion` otherwise.

```bash
# non-streaming
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"puku-default","messages":[{"role":"user","content":"hi"}]}'

# streaming (SSE)
curl -N http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"puku-default","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

#### Honored request fields

| Field      | Notes                                                                       |
|------------|-----------------------------------------------------------------------------|
| `model`    | Required. Defaults to `puku-default`.                                       |
| `messages` | Required. Array of `{role: "system"\|"user"\|"assistant", content: string}`. |
| `stream`   | Optional. Defaults to `false`.                                              |

#### Accepted-but-ignored fields (warning logged)

`temperature`, `top_p`, `n`, `max_tokens`, `presence_penalty`, `frequency_penalty`, `user`. Puku's `Options` surface does not expose these in v1 — they'll be silently dropped. If you need them, file an issue.

#### Unsupported (rejected on validation)

`tools`, `tool_choice`, `functions`, `function_call`, `response_format`, `logprobs`, `top_logprobs`, `seed`, `stop`, `logit_bias`. None of these are in scope for v1.

## How translation works

`puku-agent-sdk` spawns `puku-cli` as a subprocess and streams NDJSON messages over its stdio. We map each NDJSON line into an OpenAI SSE chunk:

| Puku message type       | OpenAI chunk                                                   |
|-------------------------|----------------------------------------------------------------|
| `system` (init)         | dropped                                                        |
| `user` (echo)           | dropped                                                        |
| `stream_event` start    | role-only chunk                                                |
| `stream_event` text_delta | `choices[0].delta.content` chunk                             |
| `stream_event` stop     | close-out chunk with `finish_reason` + `usage`                 |
| `result`                | close-out chunk + `data: [DONE]\n\n`                           |

The mapping was verified against `puku-agent-sdk@3.1.4` by capturing a real `query()` run; the NDJSON shapes live in `src/translate.ts`.

## Development

```bash
bun run dev         # watch mode
bun run typecheck   # tsc --noEmit
```

## License

UNLICENSED — private repo.
