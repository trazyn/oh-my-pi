/**
 * OpenCode gateway (Zen, Go) wire identity.
 *
 * The contributor free tier is gated on client identity before credentials
 * are evaluated: every request must carry a `User-Agent` whose leading token
 * is `opencode/<version>`, an `x-opencode-session` whose 12-hex head decodes
 * as OpenCode's `descending()` time identifier, and a non-empty `tools[]`
 * carrying the `read` name ([#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 *
 * Live-gateway evidence, invariants, and regression guards are recorded in
 * `docs/opencode-free-tier-gate.md` — read it before changing this wire shape.
 */

/**
 * Canonical OpenCode client User-Agent. The gate reads the leading token: a
 * non-`opencode` UA answers `403 FreeTierError`, and `opencode/<semver>`
 * builds below 1.18.0 answer `426 UpgradeRequired` (live bisection, Oct 2026 —
 * #12306), so the pin only has to stay above that floor.
 */
export const OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Provider ids whose hosts sit behind the OpenCode gateways (Zen, Go). */
export const OPENCODE_PROVIDER_IDS: ReadonlySet<string> = new Set(["opencode-zen", "opencode-go"]);

/** Whether `provider` is served by an OpenCode gateway. */
export function isOpenCodeProvider(provider: string): boolean {
	return OPENCODE_PROVIDER_IDS.has(provider);
}

/**
 * Tool names the body gate requires inside `tools[]`. Live-gateway bisection
 * (Oct 2026 — [#12306](https://github.com/can1357/oh-my-pi/issues/12306)):
 * a non-empty roster carrying `read` passes while `[]`, a missing `tools`
 * field, and rosters without `read` answer `403 FreeTierError`. The official
 * client's roster ships no `bash`, so `read` is the whole requirement. Agent
 * harnesses carrying a normal tool roster satisfy this natively; calls
 * missing the name must pad.
 */
export const OPENCODE_GATE_TOOL_NAMES = ["read"] as const;

/**
 * Gate tool names missing from `names` (exact-match — the gate compares names
 * only). Empty when the call already carries them and no padding is needed.
 */
export function missingOpenCodeGateToolNames(names: Iterable<string>): string[] {
	const present = new Set(names);
	return OPENCODE_GATE_TOOL_NAMES.filter(name => !present.has(name));
}

/**
 * Pad `tools` with the gate-required OpenCode tool names so tool-less auxiliary
 * calls (advisors, one-shot helpers) pass the body check. Pads carry no
 * parameters and an empty description — the gate ignores schemas — but callers
 * MUST keep them out of the agent loop's tool registry: they are wire-shape
 * filler, not executable work (the roster should never offer `read` to a call
 * that was built without tools).
 *
 * Returns the input array unchanged (same identity) when nothing is missing.
 */
export function withOpenCodeGateTools<T extends { name: string }>(tools: readonly T[] | undefined): T[] {
	const existing = tools ?? [];
	const missing = missingOpenCodeGateToolNames(existing.map(tool => tool.name));
	if (missing.length === 0) return existing as T[];
	// The stubs structurally differ from T only in fields the wire never reads.
	// `strict: false` keeps every transport's strict-mode normalization inert.
	const pads = missing.map(name => ({
		name,
		description: "",
		parameters: { type: "object" },
		strict: false,
	})) as unknown as T[];
	return [...existing, ...pads];
}

/** Shape the OpenCode gate requires for `x-opencode-session`. */
export const OPENCODE_SESSION_TOKEN_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Encode a millisecond clock reading the way OpenCode's `descending()`
 * identifier generator does: the low 48 bits of `~(ms * 0x1000 + counter)`,
 * big-endian, as 12 lowercase hex chars. (OpenCode keeps a per-millisecond
 * counter inside the free low 12 bits, starting at 1; ours is pinned to that
 * first-in-millisecond value.) The gateway decodes this head and answers `403
 * FreeTierError` when it does not read as a plausible modern timestamp — a
 * digest-random 48-bit head decodes to ~1970 (live bisection, Oct 2026 —
 * [#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 */
function encodeOpenCodeClock(milliseconds: number): string {
	const value = ~(BigInt(milliseconds) * 0x1000n + 1n);
	let head = "";
	for (let index = 0; index < 6; index++) {
		head += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0");
	}
	return head;
}

/**
 * Refresh bucket for the clock encoded into session-token heads. One day keeps
 * a conversation on one token across turns and restarts — the gateway pins
 * routing and prompt caching on the value — while the encoded reading stays
 * far inside the gate's plausibility window (live-gateway evidence: heads a
 * year old still pass).
 */
const SESSION_CLOCK_BUCKET_MS = 24 * 60 * 60 * 1000;

/**
 * Format a session identity as OpenCode's canonical session token
 * (`ses_` + 12 lowercase hex + 14 alphanumeric chars).
 *
 * The head MUST come from `encodeOpenCodeClock`: the gate decodes it and a
 * digest-random head answers `403 FreeTierError` even on an otherwise perfect
 * request. The alphanumeric tail derives from the input digest — stable
 * within the day bucket so a conversation keeps one token across turns (the
 * gateway pins routing and prompt caching on the value), distinct across
 * conversations. The tail is upper base36 (digits `0` mapped to `O`) so no
 * lowercase hex characters leak past the head segment.
 */
export function toOpenCodeSessionToken(sessionId: string): string {
	const bucket = Math.floor(Date.now() / SESSION_CLOCK_BUCKET_MS) * SESSION_CLOCK_BUCKET_MS;
	const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
	const tail = BigInt(`0x${digest}`).toString(36).toUpperCase().replace(/0/g, "O");
	return `ses_${encodeOpenCodeClock(bucket)}${tail.slice(0, 14)}`;
}
