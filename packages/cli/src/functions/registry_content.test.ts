import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY_DIR } from "../test_utils/registry";
import { REGISTRY_CONTRACT } from "./registry";
import { openRegistry } from "./source";

const schema = (name: string) =>
	JSON.parse(readFileSync(join(REGISTRY_DIR, "schemas", name), "utf8"));

const normalize = (pattern: string) => pattern.replace(/\\\//g, "/");

describe("the registry in this repository", () => {
	it("loads every template and its sources", async () => {
		const registry = await openRegistry({ kind: "dir", dir: REGISTRY_DIR });
		expect(registry.entries.map(({ id }) => id)).toEqual(["basic"]);
		for (const entry of registry.entries) {
			const { template, sources } = await registry.load(entry);
			expect(template.id).toBe(entry.id);
			expect(sources.size).toBeGreaterThan(0);
		}
	});

	it("keeps template.schema.json in step with the parser", () => {
		const template = schema("template.schema.json");
		const props = template.properties;
		const operation = props.operations.items;
		expect(template.required).toEqual(
			REGISTRY_CONTRACT.requiredTemplateFields,
		);
		expect(props.layout.enum).toEqual(REGISTRY_CONTRACT.layouts);
		expect(operation.required).toEqual(
			REGISTRY_CONTRACT.requiredOperationFields,
		);
		expect(props.operations.maxItems).toBe(REGISTRY_CONTRACT.maxOperations);
		const patterns: [string, RegExp][] = [
			[props.id.pattern, REGISTRY_CONTRACT.templateId],
			[operation.properties.id.pattern, REGISTRY_CONTRACT.operationId],
			[
				operation.properties.slug.pattern,
				REGISTRY_CONTRACT.operationSlug,
			],
			[operation.properties.route.pattern, REGISTRY_CONTRACT.route],
			[
				props.environment.items.properties.name.pattern,
				REGISTRY_CONTRACT.envName,
			],
			[props.dependencies.items.pattern, REGISTRY_CONTRACT.dependency],
		];
		for (const [actual, expected] of patterns) {
			expect(normalize(actual)).toBe(normalize(expected.source));
		}
	});

	it("keeps registry.schema.json in step with the parser", () => {
		const index = schema("registry.schema.json");
		const item = index.properties.templates.items;
		expect(index.properties.templates.maxItems).toBe(
			REGISTRY_CONTRACT.maxIndexEntries,
		);
		expect(normalize(item.properties.id.pattern)).toBe(
			normalize(REGISTRY_CONTRACT.templateId.source),
		);
	});
});
