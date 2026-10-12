import { fileURLToPath } from "node:url";

export const REGISTRY_SCHEMAS_DIR = fileURLToPath(
	new URL("../functions/schemas", import.meta.url),
);

export const FIXTURE_REGISTRY_DIR = fileURLToPath(
	new URL("../../tests/function-registry", import.meta.url),
);
