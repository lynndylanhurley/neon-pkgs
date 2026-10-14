import { describe, expect, it } from "vitest";
import { createClient } from "../supabase";

describe("supabase createClient", () => {
	it("builds a client whose auth is the Supabase-compatible adapter", () => {
		const client = createClient({
			auth: { url: "https://auth.example.com" },
			dataApi: { url: "https://data-api.example.com/rest/v1" },
		});

		expect(typeof client.auth.signInWithPassword).toBe("function");
		expect(typeof client.from).toBe("function");
	});

	it("derives the Supabase client from a single base URL", () => {
		const client = createClient(
			"https://ep-xxx.c-2.us-east-2.aws.neon.build/dbname",
		);

		expect(typeof client.auth.signInWithPassword).toBe("function");
		expect((client as unknown as { url: string }).url).toBe(
			"https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1",
		);
	});
});
