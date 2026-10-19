import { homedir } from "node:os";

import { isNetworkError } from "./errors.js";

/** Where in `neon init` / `neon skills` / `neon mcp` an error came from. */
export type ToolingErrorStep =
	| "plugins"
	| "skills"
	| "mcp"
	| "config"
	| "env_pull";

export type ToolingErrorKind =
	| "node_unsupported"
	| "node_missing"
	| "timeout"
	| "permission_denied"
	| "registry_blocked"
	| "network"
	| "invalid_config"
	| "cannot_mint_key"
	| "child_failed"
	| "unknown";

export type ToolingErrorContext = {
	step?: ToolingErrorStep;
	agents?: readonly string[];
	skills?: readonly string[];
	scope?: "project" | "global";
	/** Exit status, timeout and signal of the `skills` CLI child process. */
	exitCode?: number;
	timedOut?: boolean;
	signal?: string;
	/** Extra text to classify and report, for failures whose message doesn't carry the cause. */
	detail?: string;
	/** Joins the error to the `cli_init_start` / `cli_init_end` events of the same run. */
	initRunId?: string;
};

/**
 * What we know about an error beyond its message, kept beside the error instead of on it so
 * the error classes and the text shown to the user stay exactly as they are.
 */
const contexts = new WeakMap<object, ToolingErrorContext>();

export const toolingContextOf = (
	error: unknown,
): ToolingErrorContext | undefined =>
	typeof error === "object" && error !== null
		? contexts.get(error)
		: undefined;

/** Adds `context` to what is known about `error`; a value given here replaces an earlier one. */
export const attachToolingContext = (
	error: unknown,
	context: ToolingErrorContext,
): void => {
	if (typeof error !== "object" || error === null) {
		return;
	}
	const defined = Object.fromEntries(
		Object.entries(context).filter(([, value]) => value !== undefined),
	);
	contexts.set(error, { ...contexts.get(error), ...defined });
};

/** Records the step an error came from, unless something closer to the failure already did. */
export const tagToolingStep = (
	error: unknown,
	step: ToolingErrorStep,
): void => {
	if (toolingContextOf(error)?.step === undefined) {
		attachToolingContext(error, { step });
	}
};

/** Runs `run`, tagging whatever it throws with `step`. */
export const withToolingStep = async <T>(
	step: ToolingErrorStep,
	run: () => Promise<T>,
): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		tagToolingStep(error, step);
		throw error;
	}
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * A coarse reason for the failure, so errors can be counted instead of read one by one.
 * Anything that matches no reason is `unknown`, which is itself worth watching.
 */
export const classifyToolingError = (
	error: unknown,
	context: ToolingErrorContext | undefined = toolingContextOf(error),
): ToolingErrorKind => {
	if (error instanceof Error && error.name === "CannotMintApiKeyError") {
		return "cannot_mint_key";
	}
	const text = `${messageOf(error)}\n${context?.detail ?? ""}`;
	if (/needs Node\.js \S+ or newer/i.test(text)) {
		return "node_unsupported";
	}
	if (/needs npx|npx: command not found/i.test(text)) {
		return "node_missing";
	}
	if (context?.timedOut === true || /timed out|ETIMEDOUT/i.test(text)) {
		return "timeout";
	}
	if (/EACCES|EPERM|permission denied|operation not permitted/i.test(text)) {
		return "permission_denied";
	}
	if (/\bE403\b|\b403\b|forbidden/i.test(text)) {
		return "registry_blocked";
	}
	if (
		isNetworkError(error) ||
		/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|socket hang up/i.test(text)
	) {
		return "network";
	}
	if (
		/invalid json|unexpected token|JSON\.parse|could not parse/i.test(text)
	) {
		return "invalid_config";
	}
	if (context?.exitCode !== undefined) {
		return "child_failed";
	}
	return "unknown";
};

const DETAIL_MAX = 500;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Makes error text safe and small enough to send: no colour codes, no home directory or
 * working directory, no credentials, and at most the last {@link DETAIL_MAX} characters, which
 * is where a failed child process puts the cause (the start is progress output).
 *
 * Exported for tests.
 */
export const sanitizeErrorDetail = (text: string): string => {
	let out = text.replace(ANSI, "");
	for (const [path, replacement] of [
		[process.cwd(), "."],
		[homedir(), "~"],
	] as const) {
		if (path.length > 1) {
			out = out.replace(new RegExp(escapeRegExp(path), "g"), replacement);
		}
	}
	out = out
		.replace(/\bnapi_[A-Za-z0-9_-]+/g, "napi_<redacted>")
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//<redacted>@")
		.replace(
			/\b(api[_-]?key|token|secret|password)(["']?\s*[=:]\s*["']?)[^\s"',;]+/gi,
			"$1$2<redacted>",
		)
		.trim();
	return out.length > DETAIL_MAX ? `…${out.slice(-DETAIL_MAX)}` : out;
};

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_IDS = 20;

/** Agent and skill names come from a fixed set, but `--agent` and `--skill` take any text. */
const safeIds = (ids: readonly string[] | undefined): string[] | undefined =>
	ids === undefined
		? undefined
		: ids.filter((id) => SAFE_ID.test(id)).slice(0, MAX_IDS);

/**
 * The fields to add to the `CLI Error` event for an error from one of these commands, or
 * `undefined` for any other error. `message` and `stack` replace the originals with the
 * sanitized, bounded text.
 */
export const toolingErrorProperties = (
	error: Error,
	command: string | undefined,
): Record<string, unknown> | undefined => {
	const context = toolingContextOf(error);
	if (context === undefined) {
		return undefined;
	}
	const message = sanitizeErrorDetail(error.message);
	return {
		message,
		stack: error.stack?.replace(error.message, message),
		command,
		step: context.step,
		errorKind: classifyToolingError(error, context),
		agents: safeIds(context.agents),
		skills: safeIds(context.skills),
		scope: context.scope,
		exitCode: context.exitCode,
		timedOut: context.timedOut,
		signal: context.signal,
		detail:
			context.detail === undefined
				? undefined
				: sanitizeErrorDetail(context.detail),
		initRunId: context.initRunId,
	};
};
