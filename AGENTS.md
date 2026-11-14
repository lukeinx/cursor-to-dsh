# AGENTS.md

DeepSeek Harness (DSH) plugin that registers Cursor as the `cursor` LLM provider route. DSH owns the agent loop, tools and permissions; Cursor is only the model. The session core is ported from the author's Cursor provider for pi (cursor-to-pi).

## Layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry (`name`, `inject`, `Config`, `apply`): key lookup, working directory, adapter registration |
| `src/adapter.ts` | `CursorAdapter extends LlmAdapter`: `stream`, `listModels`, `resolveModel`, catalog cache |
| `src/transcript.ts` | DSH `GenerateOptions` -> core transcript (`user` / `developer` / `assistant` / `toolResult`) |
| `src/session.ts` | One Cursor agent per DSH session, tool-call handoff, mid-session tool changes, turn loop |
| `src/reply.ts` | DSH `StreamChunk` output and the mirrored assistant message |
| `src/models.ts` | Cursor catalog -> DSH model info and reasoning efforts -> Cursor params |
| `src/prompt.ts` | Transcript rendering, fingerprints, tool results, token estimates |
| `src/usage.ts` | Cursor usage -> DSH disjoint buckets, Cursor overhead calibration |
| `src/sdk.ts` | Cursor SDK access (agent, catalog, ripgrep path) |
| `client.js` | Browser half (`dsh.client`): the API-key card in the Cursor row of Settings → Models |
| `cordis.patch.yml` | Bundle layer that inserts the `llm-cursor` row |
| `locale/*.json`, `icon.svg` | Plugin Manager title, description and icon; no `meta.detail`, so the detail page shows the README |

## Commands

```bash
npm install
npm test         # unit tests with the fake Cursor agent
npm run check    # tsc --noEmit plus node --check client.js
npm run build    # lib/ for DSH to load
npm run check:public  # before any push to GitHub or npm publish
```

Live check (real Cursor, no DSH): `CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts`.

## Rules

- Use DSH's official seam (`ctx.llm.registerAdapter`); never wrap or patch DSH internals.
- Cursor's built-in tools stay off. DSH tools are Cursor custom (MCP) tools whose `execute` waits for DSH's result.
- DSH host packages (`@deepseek-ai/cordis`, `dsh-llm`, `dsh-credentials`, `dsh-launch-environment`, `schemastery`) are `peerDependencies` + `devDependencies`, never `dependencies`: DSH supplies the shared instances.
- Keep the route id `cursor`, model ids, the `llm-cursor` row id and `DSH_CURSOR_*` variables stable; user patches depend on them.
- The two halves meet at three stable names: the `llm-cursor` settings namespace (also the `settings.models.provider-card` key), the `__DSH_CURSOR_TO_DSH__` page global carrying `{ provider, keyRef }`, and the `CURSOR_API_KEY` fallback. Renaming any of them needs a migration note.
- Secrets go through the credentials service (`ctx.credentials`, or `credentials/set` from `client.js`); never into the profile patch, the page global, or a log line.
- Error codes stay outside DSH's default retry list; a half-finished Cursor run must not be replayed.
- Usage buckets are disjoint and `totalTokens` is omitted; DSH discards a total that disagrees with the buckets.
- New behavior gets a test through `CursorAdapter.stream()` in `test/session.test.ts` or a unit test; the browser half's contract is covered in `test/client.test.ts`.
- Source must stay type-strippable (no enums, no parameter properties); `lib/` is built by `tsc`, not committed. `client.js` is the exception: hand-written browser JavaScript, shipped as-is, requiring only the shell's `react` baseline module and never a relative `require`.
- Do not commit secrets, internal links or local absolute paths; `npm run check:public` enforces the common cases. Publishing runs `prepublishOnly` (type check, tests, build, public check); never bypass it.
