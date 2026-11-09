# @magpie-community/opencode-lightvela-auth

[中文说明](README.zh.md)

Sign in to a **LightVela** account from OpenCode or magpie, and use the
OpenAI-compatible endpoint that account carries.

LightVela gives every account an OpenAI-compatible model endpoint whose
credential lives in the account's own instance at `~/.hermes/.env`. This
plugin reads it and hands it to magpie, so you no longer have to walk
"cloud storage → agent data → show hidden files → download .env → find the
key" by hand.

## What it does

| Item | Value |
|---|---|
| Endpoint | `https://token.lightvela.com/v1` |
| Auth | `Authorization: Bearer <CUSTOM_API_KEY>` |
| Key location | `CUSTOM_API_KEY` in the instance's `~/.hermes/.env` |
| Models | whatever `/v1/models` reports for that key |

Two steps, nothing else:

1. sign in to your LightVela account and get a **session token**;
2. use that token to run one read-only command on your own instance and
   pull those two lines out.

The key never leaves your machine, passes through no third party, and is
never written to a log.

## Sign-in

`magpie plugin login lightvela`, or Providers › LightVela in the app.

### 1. Phone + SMS code (recommended)

The plugin starts a page bound to `127.0.0.1` only:

1. type the 11-digit phone number → 发送 (send)
2. type the code from the SMS → 登录 (sign in)

The page then shows the account, the instance and the models it found, and
hands the key to magpie.

### 2. Paste a session token

Already signed in on the web? Copy `lc_session` from `api.lightvela.com`
(DevTools → Application → Cookies) and paste it in. No SMS needed; replace
it when it expires.

## After sign-in

- the model list comes from the account's own `/v1/models` — read at
  sign-in and again on every refresh;
- `ep-*` (internal endpoints) and `llmgw-mock-chat` (a mock model) are
  filtered out so you can't pick something that won't answer;
- the key lives in magpie's auth; the session token lives only in
  `refresh`, used to refresh models and credits.

## Usage card

Credits come from `GET /v1/passes`: plan name, `credit_available /
credit_total`, the reset time and the pass expiry. It is read once and
cached for five minutes, so refreshing the Providers page doesn't hammer
the platform.

When the session token lapses but the key still works, the card says so and
inference keeps running — signing in again only restores the card.

## Notes

- The key belongs to the instance on the account. Using it locally works,
  but it is outside what the platform designed it for, and the upstream may
  revoke it. Keep it as a fallback rather than a primary line.
- The instance must be `Running`; one that is still initialising has no
  `.env` yet.
- The session token is used only to read your own account's instance config
  and credits.

## Uninstall

```bash
magpie plugin rm lightvela
```

The plugin adds one provider (`lightvela`) and touches nothing else.

## License

MIT
