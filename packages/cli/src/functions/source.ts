import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import {
	type FunctionTemplate,
	isContainedRelativePath,
	MAX_FILE_BYTES,
	MAX_JSON_BYTES,
	MAX_TOTAL_BYTES,
	parseRegistryIndex,
	parseTemplateItem,
	type RegistryIndexEntry,
} from "./registry.js";

// The registry lives in neondatabase/examples (`registry/`). neon.com
// serves it through a CDN-cached read-through, so listing and scaffolding never
// spend GitHub's rate limits; raw GitHub is the fallback when neon.com is down.
export const DEFAULT_REGISTRY_URL =
	"https://neon.com/functions/registry/registry.json";
export const GITHUB_REGISTRY_URL =
	"https://raw.githubusercontent.com/neondatabase/examples/main/registry/registry.json";

export const REGISTRY_DIR_ENV = "NEON_FUNCTION_REGISTRY_DIR";
export const REGISTRY_URL_ENV = "NEON_FUNCTION_REGISTRY_URL";

const REGISTRY_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RegistrySource =
	| { kind: "dir"; dir: string }
	| { kind: "url"; url: URL };

export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryError";
	}
}

export const resolveRegistrySource = (
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): RegistrySource => {
	const dir = env[REGISTRY_DIR_ENV];
	if (dir) return { kind: "dir", dir: resolve(cwd, dir) };
	const raw = env[REGISTRY_URL_ENV] || DEFAULT_REGISTRY_URL;
	if (!URL.canParse(raw)) {
		throw new RegistryError(`${REGISTRY_URL_ENV} is not a URL: ${raw}`);
	}
	const url = new URL(raw);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
	) {
		throw new RegistryError(
			`${REGISTRY_URL_ENV} must be an https:// URL, got ${raw}`,
		);
	}
	return { kind: "url", url };
};

export const describeRegistrySource = (source: RegistrySource): string =>
	source.kind === "dir" ? source.dir : source.url.href;

type ReadText = (relativePath: string, limit: number) => Promise<string>;

const tooLarge = (path: string, limit: number) =>
	new RegistryError(
		`Registry file ${path} is larger than the ${limit}-byte limit.`,
	);

const dirReader = (dir: string): ReadText => {
	let root: string;
	return async (relativePath, limit) => {
		try {
			root ??= realpathSync(dir);
		} catch {
			throw new RegistryError(
				`${REGISTRY_DIR_ENV} points at ${dir}, which does not exist.`,
			);
		}
		let path: string;
		try {
			// realpath, so a symlink inside the registry cannot reach outside it.
			path = realpathSync(resolve(root, relativePath));
		} catch {
			throw new RegistryError(
				`Registry file ${relativePath} not found in ${dir}.`,
			);
		}
		if (!path.startsWith(root + sep)) {
			throw new RegistryError(
				`Registry file ${relativePath} resolves outside ${dir}.`,
			);
		}
		if (statSync(path).size > limit) throw tooLarge(relativePath, limit);
		return readFileSync(path, "utf8");
	};
};

const urlReader = (index: URL): ReadText => {
	const base = new URL(".", index);
	return async (relativePath, limit) => {
		const url = new URL(relativePath, base);
		// `%2e%2e` is a dot segment to the URL parser, so check the result as well as the input.
		if (
			url.origin !== base.origin ||
			!url.pathname.startsWith(base.pathname)
		) {
			throw new RegistryError(
				`Registry file ${relativePath} resolves outside ${base.href}.`,
			);
		}
		let response: Response;
		try {
			response = await fetch(url, {
				redirect: "error",
				signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
			});
		} catch {
			throw new RegistryError(
				`Could not reach the Function Registry at ${url.href}. Check your connection, or set ${REGISTRY_DIR_ENV} to a local copy.`,
			);
		}
		if (!response.ok) {
			throw new RegistryError(
				`The Function Registry answered ${response.status} for ${url.href}.`,
			);
		}
		const declared = Number(response.headers.get("content-length"));
		if (declared > limit) throw tooLarge(relativePath, limit);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > limit) {
			throw tooLarge(relativePath, limit);
		}
		return text;
	};
};

export type LoadedTemplate = {
	template: FunctionTemplate;
	sources: Map<string, string>;
};

export type Registry = {
	source: RegistrySource;
	entries: RegistryIndexEntry[];
	load: (entry: RegistryIndexEntry) => Promise<LoadedTemplate>;
};

export const templateSourcePaths = (template: FunctionTemplate): string[] =>
	template.operations?.map((operation) => operation.source) ?? [
		"functions/index.ts",
	];

const INDEX_FILE = "registry.json";

/**
 * Open the registry `NEON_FUNCTION_REGISTRY_DIR` / `_URL` names, or else the
 * default on neon.com, falling back to the GitHub copy when neon.com cannot
 * serve the index. An explicit source never falls back.
 */
export const openRegistry = async (
	source?: RegistrySource,
): Promise<Registry> => {
	if (source) return openRegistryAt(source);
	const resolved = resolveRegistrySource();
	if (resolved.kind !== "url" || resolved.url.href !== DEFAULT_REGISTRY_URL) {
		return openRegistryAt(resolved);
	}
	try {
		return await openRegistryAt(resolved);
	} catch (error) {
		if (!(error instanceof RegistryError)) throw error;
		return openRegistryAt({
			kind: "url",
			url: new URL(GITHUB_REGISTRY_URL),
		});
	}
};

const openRegistryAt = async (source: RegistrySource): Promise<Registry> => {
	const read =
		source.kind === "dir" ? dirReader(source.dir) : urlReader(source.url);
	const indexPath =
		source.kind === "dir"
			? INDEX_FILE
			: posix.basename(source.url.pathname);
	const parse = <T>(path: string, text: string, fn: (text: string) => T) => {
		try {
			return fn(text);
		} catch (error) {
			throw new RegistryError(
				`Invalid registry file ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const entries = parse(
		indexPath,
		await read(indexPath, MAX_JSON_BYTES),
		parseRegistryIndex,
	);

	const load = async (entry: RegistryIndexEntry): Promise<LoadedTemplate> => {
		if (!entry.path || !isContainedRelativePath(entry.path)) {
			throw new RegistryError(
				`Template "${entry.id}" has no valid path.`,
			);
		}
		const template = parse(
			entry.path,
			await read(entry.path, MAX_JSON_BYTES),
			(text) => parseTemplateItem(text, entry.id),
		);
		const dir = posix.dirname(entry.path);
		const sources = new Map<string, string>();
		let total = 0;
		for (const path of templateSourcePaths(template)) {
			if (!isContainedRelativePath(path)) {
				throw new RegistryError(
					`Template "${entry.id}" references an unsafe path: ${path}`,
				);
			}
			const text = await read(
				dir === "." ? path : posix.join(dir, path),
				Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total),
			);
			total += Buffer.byteLength(text, "utf8");
			sources.set(path, text);
		}
		return { template, sources };
	};

	return { source, entries, load };
};
