import { describe, expect, it } from "vitest";
import { RowAssembler } from "./fragments.js";

const key = "a".repeat(64);
const encoder = new TextEncoder();
function piece(
	bytes: Uint8Array,
	offset: number | string,
	total: number | string,
	column = 0,
) {
	return {
		row_index: "0",
		row_key: key,
		column_index: column,
		offset: String(offset),
		total_bytes: String(total),
		is_null: false,
		base64: Buffer.from(bytes).toString("base64"),
	};
}

describe("fragment reassembly", () => {
	it("assembles UTF-8 across arbitrary byte boundaries, preserving a leading BOM", () => {
		const text = "\ufeff😀é漢字".repeat(32_769);
		const bytes = encoder.encode(text);
		const assembler = new RowAssembler(["pg_text"]);
		let row: ReturnType<RowAssembler["accept"]>;
		for (let offset = 0; offset < bytes.length; offset += 997) {
			row = assembler.accept(
				piece(
					bytes.subarray(offset, offset + 997),
					offset,
					bytes.length,
				),
			);
			if (offset + 997 < bytes.length) expect(row).toBeUndefined();
		}
		assembler.finish();
		expect(row).toEqual({ row_key: key, values: [text] });
	});

	it("decodes each padded binary piece separately and keeps null distinct from empty", () => {
		const assembler = new RowAssembler(["bytes", "pg_text", "bytes"]);
		expect(
			assembler.accept(piece(new Uint8Array([0, 255]), 0, 3)),
		).toBeUndefined();
		expect(() => assembler.finish()).toThrow();
		expect(
			assembler.accept(piece(new Uint8Array([128]), 2, 3)),
		).toBeUndefined();
		expect(
			assembler.accept({
				...piece(new Uint8Array(), 0, 0, 1),
				is_null: true,
			}),
		).toBeUndefined();
		expect(assembler.accept(piece(new Uint8Array(), 0, 0, 2))).toEqual({
			row_key: key,
			values: [{ base64: "AP+A" }, null, { base64: "" }],
		});
		assembler.finish();
	});

	it("round-trips a large binary cell with changing, independently padded piece sizes", () => {
		const bytes = Uint8Array.from({ length: 1_048_577 }, (_, i) => i % 256);
		const assembler = new RowAssembler(["bytes"]);
		let row: ReturnType<RowAssembler["accept"]>;
		let seed = 743745;
		for (let offset = 0; offset < bytes.length; ) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const end = Math.min(offset + 1 + (seed % 65_536), bytes.length);
			row = assembler.accept(
				piece(bytes.subarray(offset, end), offset, bytes.length),
			);
			if (end < bytes.length) expect(row).toBeUndefined();
			offset = end;
		}
		assembler.finish();
		expect(row).toEqual({
			row_key: key,
			values: [{ base64: Buffer.from(bytes).toString("base64") }],
		});
	});

	it("does not allocate declared totals and rejects mismatched offsets and identities", () => {
		const assembler = new RowAssembler(["pg_text"]);
		const first = piece(encoder.encode("a"), 0, "18446744073709551615");
		expect(assembler.accept(first)).toBeUndefined();
		expect(() => assembler.finish()).toThrow();
		for (const next of [
			{ ...first, offset: "0" },
			{ ...first, offset: "2" },
			{ ...first, offset: "1", total_bytes: "3" },
			{ ...first, offset: "1", row_key: "b".repeat(64) },
			{ ...first, offset: "1", column_index: 1 },
			{ ...first, offset: "1", base64: "" },
		])
			expect(() => assembler.accept(next)).toThrow();
	});

	it("rejects invalid UTF-8 and premature whole-row interleaving", () => {
		const assembler = new RowAssembler(["pg_text"]);
		assembler.accept(piece(new Uint8Array([0xf0, 0x9f]), 0, 4));
		expect(() =>
			assembler.acceptWhole({ row_key: key, values: ["x"] }),
		).toThrow();
		expect(() => assembler.finish()).toThrow();
		expect(() =>
			assembler.accept(piece(new Uint8Array([0, 0]), 2, 4)),
		).toThrow();
	});

	it("continues row ordinals after ordinary rows and rejects duplicate completion", () => {
		const assembler = new RowAssembler(["pg_text"]);
		assembler.acceptWhole({ row_key: key, values: ["before"] });
		const next = {
			...piece(encoder.encode("after"), 0, 5),
			row_index: "1",
		};
		expect(assembler.accept(next)).toEqual({
			row_key: key,
			values: ["after"],
		});
		expect(() => assembler.accept(next)).toThrow();
		assembler.finish();
	});
});
