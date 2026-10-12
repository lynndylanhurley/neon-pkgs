import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubTarballUrl } from "../init/bootstrap";
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

	it("reads loose source files from the directory", async () => {
		mkdirSync(join(dir, "demo/functions"));
		writeFileSync(
			join(dir, "demo/functions/index.ts"),
			"export default { fetch() { return new Response(); } };\n",
		);
		const loaded = await loadDemo();
		expect(loaded.sources.get("functions/index.ts")).toContain("fetch()");
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

const INDEX_WITH_DEMO = JSON.stringify({
	templates: [
		{
			id: "demo",
			title: "Demo",
			description: "d",
			path: "demo/template.json",
		},
	],
});

const DEMO_TEMPLATE = JSON.stringify({
	id: "demo",
	title: "Demo",
	description: "d",
	layout: "router",
});

const tarHeader = (
	name: string,
	size: number,
	typeflag: string,
	linkname = "",
): Buffer => {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, "utf8");
	header.write("0000644\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(typeflag, 156, 1);
	header.write(linkname, 157, "utf8");
	header.write("ustar\0", 257);
	header.write("00", 263);
	let sum = 0;
	for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
};

const padTo512 = (buf: Buffer): Buffer => {
	const rem = buf.length % 512;
	return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
};

const gzipTar = (
	entries: Array<
		| { name: string; type: "file"; content: string }
		| { name: string; type: "symlink"; target: string }
	>,
): Buffer => {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		if (entry.type === "symlink") {
			blocks.push(tarHeader(entry.name, 0, "2", entry.target));
			continue;
		}
		const content = Buffer.from(entry.content);
		blocks.push(tarHeader(entry.name, content.length, "0"));
		blocks.push(padTo512(content));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.from(gzipSync(new Uint8Array(Buffer.concat(blocks))));
};

const examplesTar = githubTarballUrl("neondatabase", "examples", "main");

describe("openRegistry URL load uses the GitHub tarball", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	beforeEach(() => {
		vi.stubEnv("NEON_FUNCTION_REGISTRY_DIR", "");
		vi.stubEnv("NEON_FUNCTION_REGISTRY_URL", "");
	});

	const stub = (gzipped: Buffer) => {
		const fetch = vi.fn(async (url: URL) => {
			const href = String(url);
			if (href === DEFAULT_REGISTRY_URL) {
				return new Response(INDEX_WITH_DEMO);
			}
			if (href === examplesTar) {
				return new Response(gzipped);
			}
			return new Response("no", { status: 404 });
		});
		vi.stubGlobal("fetch", fetch);
		return fetch;
	};

	it("extracts template.json and modules from registry/<id>/", async () => {
		const gzipped = gzipTar([
			{
				name: "examples-main/registry/demo/template.json",
				type: "file",
				content: DEMO_TEMPLATE,
			},
			{
				name: "examples-main/registry/demo/functions/index.ts",
				type: "file",
				content: "export default {};\n",
			},
			{
				name: "examples-main/with-hono/package.json",
				type: "file",
				content: "{}",
			},
		]);
		const fetch = stub(gzipped);
		const registry = await openRegistry();
		const [entry] = registry.entries;
		if (!entry) throw new Error("missing entry");
		const loaded = await registry.load(entry);
		expect(loaded.sources.get("functions/index.ts")).toBe(
			"export default {};\n",
		);
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			DEFAULT_REGISTRY_URL,
			examplesTar,
		]);
	});

	it("rejects a symlink in the template directory", async () => {
		const gzipped = gzipTar([
			{
				name: "examples-main/registry/demo/template.json",
				type: "file",
				content: DEMO_TEMPLATE,
			},
			{
				name: "examples-main/registry/demo/functions/index.ts",
				type: "symlink",
				target: "../../secret.ts",
			},
		]);
		stub(gzipped);
		const registry = await openRegistry();
		const [entry] = registry.entries;
		if (!entry) throw new Error("missing entry");
		await expect(registry.load(entry)).rejects.toThrow(/non-file/);
	});

	it("rejects a tarball that is missing the module", async () => {
		const gzipped = gzipTar([
			{
				name: "examples-main/registry/demo/template.json",
				type: "file",
				content: DEMO_TEMPLATE,
			},
		]);
		stub(gzipped);
		const registry = await openRegistry();
		const [entry] = registry.entries;
		if (!entry) throw new Error("missing entry");
		await expect(registry.load(entry)).rejects.toThrow(/missing/);
	});
});
