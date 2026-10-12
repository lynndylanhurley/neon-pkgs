import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REGISTRY_URL,
	describeRegistrySource,
	GITHUB_REGISTRY_URL,
	openRegistry,
	resolveRegistrySource,
} from "./source";

describe("resolveRegistrySource", () => {
	it("prefers a local directory, then a URL, then the default", () => {
		expect(
			resolveRegistrySource(
				{ NEON_FUNCTION_REGISTRY_DIR: "reg" },
				"/work",
			),
		).toEqual({ kind: "dir", dir: "/work/reg" });
		expect(
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL:
					"https://example.com/r/registry.json",
			}),
		).toMatchObject({ kind: "url" });
		const fallback = resolveRegistrySource({});
		expect(fallback.kind === "url" && fallback.url.href).toBe(
			DEFAULT_REGISTRY_URL,
		);
	});

	it("refuses plain HTTP except on loopback", () => {
		expect(() =>
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL: "http://example.com/registry.json",
			}),
		).toThrow(/https/);
		expect(
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL:
					"http://localhost:3000/registry.json",
			}),
		).toMatchObject({ kind: "url" });
	});
});

describe("openRegistry from a directory", () => {
	let dir: string;
	let outside: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neon-registry-"));
		outside = mkdtempSync(join(tmpdir(), "neon-registry-outside-"));
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				templates: [
					{
						id: "demo",
						title: "Demo",
						description: "d",
						path: "demo/template.json",
					},
				],
			}),
		);
		mkdirSync(join(dir, "demo"));
		writeFileSync(
			join(dir, "demo/template.json"),
			JSON.stringify({
				id: "demo",
				title: "Demo",
				description: "d",
				layout: "router",
			}),
		);
	});

	const loadDemo = async () => {
		const registry = await openRegistry({ kind: "dir", dir });
		const [entry] = registry.entries;
		if (!entry) throw new Error("demo entry did not parse");
		return registry.load(entry);
	};

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("refuses a source symlinked outside the registry", async () => {
		writeFileSync(join(outside, "secret.ts"), "export {};\n");
		mkdirSync(join(dir, "demo/functions"));
		symlinkSync(
			join(outside, "secret.ts"),
			join(dir, "demo/functions/index.ts"),
		);
		await expect(loadDemo()).rejects.toThrow(/outside/);
	});

	it("reports a missing source", async () => {
		await expect(loadDemo()).rejects.toThrow(/not found/);
	});
});

describe("openRegistry with the default source", () => {
	const index = JSON.stringify({ templates: [] });

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	beforeEach(() => {
		vi.stubEnv("NEON_FUNCTION_REGISTRY_DIR", "");
		vi.stubEnv("NEON_FUNCTION_REGISTRY_URL", "");
	});

	it("reads the index from neon.com", async () => {
		const fetch = vi.fn(async (_url: URL) => new Response(index));
		vi.stubGlobal("fetch", fetch);
		const registry = await openRegistry();
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			DEFAULT_REGISTRY_URL,
		]);
		expect(describeRegistrySource(registry.source)).toBe(
			DEFAULT_REGISTRY_URL,
		);
	});

	it("falls back to GitHub when neon.com fails", async () => {
		const fetch = vi.fn(async (url: URL) =>
			url.href === DEFAULT_REGISTRY_URL
				? new Response("", { status: 503 })
				: new Response(index),
		);
		vi.stubGlobal("fetch", fetch);
		const registry = await openRegistry();
		expect(describeRegistrySource(registry.source)).toBe(
			GITHUB_REGISTRY_URL,
		);
	});

	it("never falls back from an explicit URL", async () => {
		vi.stubEnv(
			"NEON_FUNCTION_REGISTRY_URL",
			"https://example.com/registry.json",
		);
		const fetch = vi.fn(async () => new Response("", { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		await expect(openRegistry()).rejects.toThrow(/503/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
