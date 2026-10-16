# OpenCode Free-Tier Gate (Zen / Go)

OpenCode's Zen and Go gateways serve contributor free models only to requests that present the canonical OpenCode client identity. The check runs before credentials are evaluated and is easy to get wrong: the `x-opencode-session` header is **decoded**, not just shape-checked.

This document records the live-gateway contract bisected in Oct 2026 (issue [#12306](https://github.com/can1357/oh-my-pi/issues/12306)), where it is implemented, which invariants future refactors must preserve, and how to re-verify when the gateway changes. Keep it in sync with reality — it exists so this implementation is not "simplified" back into a `403 FreeTierError`.

## The contract

Every request to a free-tier-capable OpenCode endpoint (all transports) must satisfy three independent checks.

### 1. `User-Agent`

The leading token must be `opencode/<semver>`.

| UA                                     | Result               |
| -------------------------------------- | -------------------- |
| `opencode/1.18.31`                     | accepted             |
| `opencode/1.17.0`                      | `426 UpgradeRequired` |
| `omp/18.11.1` (any non-`opencode` token) | `403 FreeTierError`  |

`OPENCODE_USER_AGENT` pins the canonical value; the pin only has to stay above the 1.18.0 floor. Only an explicit caller UA override (e.g. a Claude OAuth fingerprint) may win.

### 2. `x-opencode-session`

Shape: `ses_` + 12 lowercase hex + 14 alphanumeric characters — **and the 12-hex head is decoded as OpenCode's `descending()` time identifier.**

OpenCode's generator (`identifier.ts`) encodes `~((Date.now() * 0x1000) + counter)` as the low 48 bits, big-endian. The gateway inverts the head, and a head that does not read as a plausible modern clock answers `403 FreeTierError` even when every other byte of the request is byte-identical to a passing request.

Live evidence (same body, same headers; only the head varies):

| Head source                                                      | Result               |
| ---------------------------------------------------------------- | -------------------- |
| reference generator, fresh                                       | accepted             |
| reference generator, ages up to a year old (and 1h in the future) | accepted             |
| random 48 bits / sha256 prefix                                   | `403 FreeTierError`  |

The tolerance is a plausibility window, not recency — only the decoded reading must stay inside it. `toOpenCodeSessionToken` therefore buckets the encoded clock to a day (`SESSION_CLOCK_BUCKET_MS`): one conversation keeps one token across turns and restarts within the day (the gateway pins routing and prompt caching on the value), while the reading is always far inside the window. The 14-char tail derives from a digest of the session id, so distinct conversations get distinct tokens without touching the decoded head.

Inverting the head recovers `ms mod 2^36` (the low 12 bits carry the reference generator's per-millisecond counter; ours is pinned to 1, its first-in-millisecond value). A digest-derived head decodes to ~1970.

### 3. Body `tools[]`

Must be non-empty and carry the name `read` (exact match; schemas are ignored).

| `tools`                                              | Result              |
| ---------------------------------------------------- | ------------------- |
| `[bash, read]`, `[read]`, official v2 roster (no `bash`) | accepted        |
| `[grep, glob]`, `[]`, missing `tools` field          | `403 FreeTierError` |

`bash` is **not** required — the official client's roster does not ship it. An earlier bisection concluded the gate needs a `bash` + `read` pair; those probes were confounded by invalid session heads (every combination was refused for that reason). Do not re-add stubs without new live evidence.

### Not required (verified by replay)

Extra `x-opencode-*` headers (`client`, `project`, `session-id` aliases, affinity), `b3`/`traceparent` tracing headers, header ordering, the transport (Bun fetch and curl both pass), and the API key itself (`Bearer public` passes — the gate is client policy, not auth).

## Where it is implemented

| Area                    | File                                                                                                           | Role                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Single source of truth  | `packages/catalog/src/wire/opencode.ts`                                                                        | identity constants, `toOpenCodeSessionToken`, `withOpenCodeGateTools`, gate tool names                                   |
| Inference headers       | `packages/ai/src/providers/inference-headers.ts`                                                               | applies UA + session token on every OpenCode request; install-id fallback outside conversations                         |
| Tool padding            | `packages/ai/src/utils/opencode-gate.ts`                                                                       | `withOpenCodeGateShape` on both dispatch funnels; `tool_choice: "none"` pin for padded tool-less calls                   |
| Discovery               | `packages/catalog/src/provider-models/openai-compat.ts`                                                        | live model discovery attribution                                                                                         |
| Usage                   | `packages/ai/src/usage/opencode-go.ts`                                                                         | usage poll attribution                                                                                                   |
| Error semantics         | `packages/ai/src/error/flags.ts`, `error/auth-classify.ts`, `auth-retry.ts`, `error/format.ts`, `src/stream.ts` | `FreeTierError` 403 is model-scoped: never rotates sibling credentials; the rewrite keeps the marker for classifiers     |

## Invariants future refactors must preserve

- The session head MUST come from `encodeOpenCodeClock`. Never substitute a digest, random bytes, or a truncated hash — shape alone does not pass.
- Keep the encoded clock fresh via the day bucket. Do not hard-code a fixed epoch (it ages out of the plausibility window) and do not regenerate per request (it destroys the routing/prompt-cache pinning the gateway does on the value).
- Pad exactly the gate-required names — today `read`. Do not re-add `bash` stubs without new live evidence.
- Keep the canonical UA on inference, discovery, and usage paths; background traffic without a conversation derives its token from the install id.
- Keep `isOpencodeFreeTierGateMessage` in the no-rotation paths (`auth-retry.ts`, `error/auth-classify.ts`, `stream.ts`) and keep the `FreeTierError` marker in rewritten messages.

## Regression guards

These tests fail if the implementation is reverted; keep them passing rather than deleting them:

- `packages/ai/test/opencode-session-header.test.ts` — token shape, deterministic within the day bucket, and the 12-hex head inverting to a current clock reading (the same decode the gateway performs).
- `packages/ai/test/opencode-free-tier-gate.test.ts` — the padded roster is exactly `[read]`; tool-less calls on both dispatch funnels reach the wire with it; `tool_choice` pin rules; the `FreeTierError` rewrite.
- `packages/catalog/test/opencode-provider.test.ts` — discovery requests carry the canonical UA and a time-encoded session token.
- `packages/ai/test/opencode-go-usage.test.ts` — usage polls carry the same identity.
- `packages/ai/test/auth-retry.test.ts` — a `FreeTierError` 403 never rotates credentials.

## Re-verifying when the gateway answers 403 again

1. Reproduce with the current binary and note the exact model (`400 Model is unavailable` means the model was delisted upstream — not a gate problem).
2. Capture what the official client sends: point `opencode` at a local capture server (override its `baseURL`), run `opencode run --model opencode/<free-model>`, and record headers + body.
3. Replay the captured request against the real endpoint with `Bearer public` — the gate ignores the key, so no account is needed.
4. Bisect one variable at a time (headers, body, session head). The session head was the discriminator in Oct 2026; the next change may be elsewhere.
5. Update `wire/opencode.ts`, this document, and the regression guards together — and never commit probe scripts or captured payloads.
