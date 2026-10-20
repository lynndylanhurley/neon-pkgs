import { describe, expect, it } from "vitest";

import { validateServerMessage as validateV1 } from "../schema-validator.gen.js";
import { validateServerMessage as validateV2 } from "../schema-validator-v2.gen.js";
import legacyFixtures from "./realtime-protocol-v1.fixtures.json";
import fragmentFixtures from "./realtime-protocol-v2.fixtures.json";

const piece = {
	row_index: "0",
	row_key: "a".repeat(64),
	column_index: 0,
	offset: "0",
	total_bytes: "1048576",
	is_null: false,
	base64: "eA==",
};
const baseline = {
	type: "baseline_sync_fragment",
	live_id: "1",
	epoch: "1",
	baseline_sync_attempt: "1",
	index: 0,
	pieces: [piece],
};

describe("negotiated fragment wire contracts", () => {
	it("validates shared fragments without interpreting partial UTF-8", () => {
		for (const fixture of fragmentFixtures.valid) {
			expect(validateV2(fixture)).toBe(true);
			expect(validateV1(fixture)).toBe(false);
		}
		for (const fixture of fragmentFixtures.invalid)
			expect(validateV2(fixture)).toBe(false);
	});
	it("keeps complete v1 messages valid under v2", () => {
		for (const fixture of legacyFixtures.valid) {
			if (validateV1(fixture)) expect(validateV2(fixture)).toBe(true);
		}
	});

	it("admits larger declared values only through the v2 dialect", () => {
		expect(validateV2(baseline)).toBe(true);
		expect(validateV1(baseline)).toBe(false);
		expect(
			validateV2({
				...baseline,
				pieces: [{ ...piece, offset: "65536" }],
			}),
		).toBe(true);
	});

	it("bounds physical pieces, payload strings and integer representations", () => {
		for (const pieces of [
			[],
			Array.from({ length: 257 }, () => piece),
			[{ ...piece, base64: "AAAA".repeat(21847) }],
			[{ ...piece, offset: "01" }],
			[{ ...piece, offset: "18446744073709551616" }],
			[{ ...piece, total_bytes: 1048576 }],
			[{ ...piece, column_index: 256 }],
			[{ ...piece, unexpected: true }],
		]) {
			expect(validateV2({ ...baseline, pieces })).toBe(false);
		}
	});

	it("distinguishes null and empty cells and rejects null payloads", () => {
		const empty = { ...piece, total_bytes: "0", base64: "" };
		expect(validateV2({ ...baseline, pieces: [empty] })).toBe(true);
		expect(
			validateV2({ ...baseline, pieces: [{ ...empty, is_null: true }] }),
		).toBe(true);
		expect(
			validateV2({ ...baseline, pieces: [{ ...piece, is_null: true }] }),
		).toBe(false);
	});

	it("describes patch continuation separately from physical publication order", () => {
		const patch = {
			type: "keyed_results_fragment",
			publication_id: "1:1",
			index: 2,
			part_index: 1,
			is_last: true,
			txids: ["2"],
			targets: [{ live_id: "1", epoch: "1", sequence: "1" }],
			pieces: [
				{
					op: "upsert",
					...piece,
					row_index: "1",
					offset: "2",
					total_bytes: "3",
				},
				{ op: "remove", row_index: "2", row_key: "b".repeat(64) },
			],
		};
		expect(validateV2(patch)).toBe(true);
		expect(validateV1(patch)).toBe(false);
		expect(validateV2({ ...patch, part_index: -1 })).toBe(false);
	});
});
