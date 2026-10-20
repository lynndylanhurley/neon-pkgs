import { expect, it } from "vitest";
import { decodeServerFrame } from "./codec.js";

function fragment(size = 1) {
	return {
		type: "baseline_sync_fragment",
		live_id: "1",
		epoch: "1",
		baseline_sync_attempt: "1",
		index: 0,
		pieces: [
			{
				row_index: "0",
				row_key: "a".repeat(64),
				column_index: 0,
				offset: "0",
				total_bytes: "1048576",
				is_null: false,
				base64: Buffer.alloc(size).toString("base64"),
			},
		],
	};
}
it("accepts fragments only with the selected v2 dialect", () => {
	const text = JSON.stringify(fragment());
	expect(() => decodeServerFrame(text)).toThrow();
	expect(() => decodeServerFrame(text, "neon.realtime.v1")).toThrow();
	expect(decodeServerFrame(text, "neon.realtime.v2").message).toEqual(
		fragment(),
	);
	expect(() => decodeServerFrame('{"type":"ready"}', "unknown")).toThrow();
});
it("checks aggregate decoded payload independently of schema per-piece bounds", () => {
	const message = fragment(40_000);
	const first = message.pieces[0];
	if (!first) throw new Error("missing test fragment");
	message.pieces.push({ ...first });
	expect(() =>
		decodeServerFrame(JSON.stringify(message), "neon.realtime.v2"),
	).toThrow(/payload limit/);
	const legal = fragment(65_536);
	expect(
		decodeServerFrame(JSON.stringify(legal), "neon.realtime.v2").message,
	).toEqual(legal);
});
