import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "@neon/config-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderNeonConfig } from "../config_template";
import { openRegistry, type Registry } from "../functions/source";
import { FIXTURE_REGISTRY_DIR } from "../test_utils/registry";
import {
	type ScaffoldFromTemplateOptions,
	scaffoldFromTemplate,
} from "./functions_new";

const MAILER_ENV_EXAMPLE = "# API key for the mailer.\nMAILER_API_KEY=\n";

describe("functions new", () => {
	let workspace: string;
	let registry: Registry;

	beforeEach(async () => {
		workspace = mkdtempSync(join(tmpdir(), "neon-functions-new-"));
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		registry = await openRegistry({
			kind: "dir",
			dir: FIXTURE_REGISTRY_DIR,
		});
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	const read = (path: string) => readFileSync(join(workspace, path), "utf8");
	const run = (
		options: Omit<ScaffoldFromTemplateOptions, "registry" | "interactive">,
	) =>
		scaffoldFromTemplate({
			cwd: workspace,
			registry,
			interactive: false,
			install: false,
			...options,
		});

	it("scaffolds a router template as one function", async () => {
		const result = await run({
			template: "notes",
			operations: ["list", "health"],
		});

		expect(result).toMatchObject({
			cancelled: false,
			layout: "router",
			routes: ["/list", "/health"],
			functions: [{ slug: "notes", source: "functions/notes/index.ts" }],
			config: { path: "neon.ts", action: "updated" },
		});
		expect(read("functions/notes/list.ts")).toBe(
			readFileSync(
				join(FIXTURE_REGISTRY_DIR, "notes/functions/list.ts"),
				"utf8",
			),
		);
		expect(existsSync(join(workspace, "functions/notes/get.ts"))).toBe(
			false,
		);
		const router = read("functions/notes/index.ts");
		expect(router).toContain('import op0 from "./list";');
		expect(router).toContain('"/health": op1,');
		expect(read("neon.ts")).toContain(
			'notes: { name: "Notes API", source: "./functions/notes/index.ts" }',
		);
	});

	it("uses the recommended operations and an operation's own route", async () => {
		const result = await run({ template: "notes" });

		expect(result).toMatchObject({ routes: ["/list", "/note"] });
		expect(existsSync(join(workspace, "functions/notes/health.ts"))).toBe(
			false,
		);
	});

	it("scaffolds a separate template as one function per recommended operation", async () => {
		const result = await run({ template: "mailer" });

		expect(result).toMatchObject({
			environment: ["MAILER_API_KEY"],
			dependencies: ["mailer-sdk@1.2.3"],
			installed: false,
		});
		expect(result.cancelled === false && result.nextSteps[0]).toMatch(
			/Install the template's dependencies: `.*mailer-sdk@1\.2\.3`/,
		);
		const config = read("neon.ts");
		for (const [slug, id] of [
			["mailsend", "send"],
			["mailget", "get"],
		]) {
			expect(config).toContain(`${slug}: {`);
			expect(config).toContain(`source: "./functions/mailer/${id}.ts"`);
		}
		expect(config).not.toContain("mailcancel");
		expect(existsSync(join(workspace, "functions/mailer/index.ts"))).toBe(
			false,
		);
	});

	it("declares the template's env in neon.ts and lists it in .env.example", async () => {
		await run({ template: "mailer", operations: ["send"] });

		expect(read("neon.ts")).toContain(
			"env: { MAILER_API_KEY: process.env.MAILER_API_KEY! }",
		);
		expect(read(".env.example")).toBe(MAILER_ENV_EXAMPLE);
		expect(existsSync(join(workspace, ".env.local"))).toBe(false);
	});

	it("appends to an existing .env.example without repeating a name", async () => {
		writeFileSync(join(workspace, ".env.example"), "DATABASE_URL=");
		const expected = `DATABASE_URL=\n\n${MAILER_ENV_EXAMPLE}`;

		const first = await run({ template: "mailer", operations: ["send"] });
		expect(read(".env.example")).toBe(expected);
		expect(first).toMatchObject({
			envExample: { path: ".env.example", added: ["MAILER_API_KEY"] },
		});

		const second = await run({
			template: "mailer",
			operations: ["cancel"],
			name: "mailer2",
		});
		expect(read(".env.example")).toBe(expected);
		expect(second).not.toHaveProperty("envExample");
	});

	it("points deploy at the env file and the shell at dev", async () => {
		const result = await run({ template: "mailer", operations: ["send"] });

		expect(result.cancelled === false && result.nextSteps).toEqual(
			expect.arrayContaining([
				"Set MAILER_API_KEY (API key for the mailer.) in .env.local. `neon dev` reads it from your shell, so export it there too.",
				"Next: `neon dev` to run it locally, `neon config apply --env .env.local` to deploy.",
			]),
		);
	});

	it("writes a neon.ts that loads with the env set and names it when unset", async () => {
		const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
		const project = mkdtempSync(
			join(packageRoot, "node_modules", ".neon-functions-new-"),
		);
		const previous = process.env.MAILER_API_KEY;
		try {
			writeFileSync(join(project, "neon.ts"), renderNeonConfig([]));
			await run({
				template: "mailer",
				operations: ["send"],
				cwd: project,
			});

			process.env.MAILER_API_KEY = "key_test";
			const { config } = await loadConfigFromFile({
				path: join(project, "neon.ts"),
			});
			expect(config.functions?.mailsend?.env).toEqual({
				MAILER_API_KEY: "key_test",
			});

			delete process.env.MAILER_API_KEY;
			await expect(
				loadConfigFromFile({ path: join(project, "neon.ts") }),
			).rejects.toThrow(/MAILER_API_KEY/);
		} finally {
			if (previous === undefined) delete process.env.MAILER_API_KEY;
			else process.env.MAILER_API_KEY = previous;
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("copies a template without operations to index.ts", async () => {
		await run({ template: "hello", addToConfig: false });

		expect(read("functions/hello/index.ts")).toBe(
			readFileSync(
				join(FIXTURE_REGISTRY_DIR, "hello/functions/index.ts"),
				"utf8",
			),
		);
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});

	it("refuses to overwrite a differing file without --force", async () => {
		mkdirSync(join(workspace, "functions/hello"), { recursive: true });
		writeFileSync(join(workspace, "functions/hello/index.ts"), "mine\n");

		await expect(run({ template: "hello" })).rejects.toThrow(/--force/);
		expect(read("functions/hello/index.ts")).toBe("mine\n");
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});

	it("refuses a slug neon.ts already declares, before writing anything", async () => {
		await run({ template: "hello" });
		rmSync(join(workspace, "functions"), { recursive: true });

		await expect(run({ template: "hello" })).rejects.toThrow(
			/already declares hello/,
		);
		expect(existsSync(join(workspace, "functions"))).toBe(false);
	});

	it("rejects an unknown operation and an unknown template", async () => {
		await expect(
			run({ template: "mailer", operations: ["nope"] }),
		).rejects.toThrow(/Unknown operation "nope"/);
		await expect(run({ template: "nope" })).rejects.toThrow(
			/Available templates: hello, notes, mailer/,
		);
	});
});
