import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../protocol/messages.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";
import {
	baselineSyncEnd,
	baselineSyncStart,
	completeEmptyBaselineSync,
	ROW_A,
	target,
} from "./reconciler.test-helpers.js";

function rowPiece(text: string, offset: number, total: number) {
	return {
		row_index: "0",
		row_key: ROW_A,
		column_index: 0,
		offset: String(offset),
		total_bytes: String(total),
		is_null: false,
		base64: btoa(text),
	};
}
function setup(events: string[] = []) {
	const reconciler = new BaselineSyncPublicationReconciler();
	const output = target(events);
	reconciler.add({
		liveId: "9",
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		columnCodecs: ["pg_text"],
		target: output,
	});
	return { reconciler, output };
}
function part(
	index: number,
	last: boolean,
	text: string,
	offset: number,
): Extract<ServerMessage, { type: "keyed_results_fragment" }> {
	return {
		type: "keyed_results_fragment" as const,
		publication_id: "p",
		index,
		part_index: index,
		is_last: last,
		txids: ["7"],
		targets: [{ live_id: "9", epoch: "1", sequence: "1" }],
		pieces: [{ op: "upsert" as const, ...rowPiece(text, offset, 3) }],
	};
}

describe("fragment visibility", () => {
	it("installs a fragmented baseline only at its end", () => {
		const { reconciler, output } = setup();
		reconciler.accept(baselineSyncStart());
		for (const [index, text, offset] of [
			[0, "ab", 0],
			[1, "c", 2],
		] as const) {
			reconciler.accept({
				type: "baseline_sync_fragment",
				live_id: "9",
				epoch: "1",
				baseline_sync_attempt: "1",
				index,
				pieces: [rowPiece(text, offset, 3)],
			});
			expect(output.installReset).not.toHaveBeenCalled();
		}
		reconciler.accept(baselineSyncEnd(2));
		expect(output.installReset).toHaveBeenCalledWith([
			{ row_key: ROW_A, values: ["abc"] },
		]);
	});

	it("commits a multipart patch once and advances its sequence once", () => {
		const events: string[] = [];
		const { reconciler, output } = setup(events);
		completeEmptyBaselineSync(reconciler);
		events.length = 0;
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(part(0, false, "ab", 0));
		reconciler.accept(part(1, true, "c", 2));
		expect(events).toEqual([]);
		reconciler.accept({
			type: "commit",
			publication_id: "p",
			body_count: 2,
			frontier: { lsn: "0/1" },
		});
		expect(output.applyBatch).toHaveBeenCalledWith([
			{ op: "upsert", row_key: ROW_A, values: ["abc"] },
		]);
		expect(events).toEqual(["apply:a", "publishBatch:7:a"]);
		reconciler.accept({ type: "open", publication_id: "next" });
		reconciler.accept({
			type: "keyed_results",
			publication_id: "next",
			index: 0,
			txids: ["8"],
			targets: [{ live_id: "9", epoch: "1", sequence: "2" }],
			changes: [{ op: "remove", row_key: ROW_A }],
		});
		reconciler.accept({
			type: "commit",
			publication_id: "next",
			body_count: 1,
			frontier: { lsn: "0/2" },
		});
	});

	it("rejects commit/end or a final part while data is incomplete", () => {
		const { reconciler, output } = setup();
		completeEmptyBaselineSync(reconciler);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(part(0, false, "a", 0));
		expect(() =>
			reconciler.accept({
				type: "commit",
				publication_id: "p",
				body_count: 1,
				frontier: { lsn: "0/1" },
			}),
		).toThrow();
		expect(output.applyBatch).not.toHaveBeenCalled();
		reconciler.clear();
		const second = setup();
		completeEmptyBaselineSync(second.reconciler);
		second.reconciler.accept({ type: "open", publication_id: "p" });
		expect(() => second.reconciler.accept(part(0, true, "a", 0))).toThrow();
		const third = setup();
		third.reconciler.accept(baselineSyncStart());
		third.reconciler.accept({
			type: "baseline_sync_fragment",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			pieces: [rowPiece("a", 0, 3)],
		});
		expect(() => third.reconciler.accept(baselineSyncEnd(1))).toThrow();
		expect(third.output.installReset).not.toHaveBeenCalled();
	});

	it("installs all participating targets before notifying either", () => {
		const events: string[] = [];
		const { reconciler } = setup(events);
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			columnCodecs: ["pg_text"],
			target: target(events, "other"),
		});
		completeEmptyBaselineSync(reconciler);
		completeEmptyBaselineSync(reconciler, "10");
		events.length = 0;
		reconciler.accept({ type: "open", publication_id: "p" });
		for (const message of [
			part(0, false, "ab", 0),
			part(1, true, "c", 2),
		]) {
			message.targets.push({ live_id: "10", epoch: "1", sequence: "1" });
			reconciler.accept(message);
		}
		reconciler.accept({
			type: "commit",
			publication_id: "p",
			body_count: 2,
			frontier: { lsn: "0/1" },
		});
		expect(events).toEqual([
			"apply:a",
			"other:apply:a",
			"publishBatch:7:a",
			"other:publishBatch:7:a",
		]);
	});
	it("drops partial values on a replacement baseline attempt", () => {
		const { reconciler, output } = setup();
		reconciler.accept(baselineSyncStart());
		reconciler.accept({
			type: "baseline_sync_fragment",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			pieces: [rowPiece("old", 0, 6)],
		});
		reconciler.accept(baselineSyncStart("1", "2"));
		reconciler.accept({
			type: "baseline_sync_fragment",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 1,
			pieces: [rowPiece("bad", 3, 6)],
		});
		reconciler.accept({
			type: "baseline_sync_fragment",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "2",
			index: 0,
			pieces: [rowPiece("new", 0, 3)],
		});
		reconciler.accept({
			...baselineSyncEnd(1),
			baseline_sync_attempt: "2",
		});
		expect(output.installReset).toHaveBeenCalledExactlyOnceWith([
			{ row_key: ROW_A, values: ["new"] },
		]);
	});

	it("releases inactive patch recipients while completing an active sibling", () => {
		const { reconciler, output } = setup();
		const sibling = target();
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			columnCodecs: ["pg_text"],
			target: sibling,
		});
		completeEmptyBaselineSync(reconciler);
		completeEmptyBaselineSync(reconciler, "10");
		reconciler.accept({ type: "open", publication_id: "p" });
		const first = part(0, false, "ab", 0);
		first.targets.push({ live_id: "10", epoch: "1", sequence: "1" });
		reconciler.accept(first);
		reconciler.deactivate("9");
		const last = part(1, true, "c", 2);
		last.targets = first.targets;
		reconciler.accept(last);
		reconciler.accept({
			type: "commit",
			publication_id: "p",
			body_count: 2,
			frontier: { lsn: "0/1" },
		});
		expect(output.applyBatch).not.toHaveBeenCalled();
		expect(sibling.applyBatch).toHaveBeenCalledExactlyOnceWith([
			{ op: "upsert", row_key: ROW_A, values: ["abc"] },
		]);
	});

	it("rejects changed attribution and mixed ordinary/fragment patches", () => {
		for (const mutation of ["txid", "sequence", "ordinary"] as const) {
			const { reconciler } = setup();
			completeEmptyBaselineSync(reconciler);
			reconciler.accept({ type: "open", publication_id: "p" });
			reconciler.accept(part(0, false, "ab", 0));
			const next = part(1, true, "c", 2);
			if (mutation === "txid") next.txids = ["8"];
			if (mutation === "sequence") next.targets[0].sequence = "2";
			expect(() =>
				reconciler.accept(
					mutation === "ordinary"
						? {
								type: "keyed_results",
								publication_id: "p",
								index: 1,
								txids: ["7"],
								targets: next.targets,
								changes: [{ op: "remove", row_key: ROW_A }],
							}
						: next,
				),
			).toThrow();
		}
	});

	it("discards an unfinished patch when its last recipient deactivates", () => {
		const { reconciler, output } = setup();
		completeEmptyBaselineSync(reconciler);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(part(0, false, "ab", 0));
		reconciler.deactivate("9");
		reconciler.accept({
			type: "commit",
			publication_id: "p",
			body_count: 1,
			frontier: { lsn: "0/1" },
		});
		expect(output.applyBatch).not.toHaveBeenCalled();
	});

	it("keeps interleaved logical patches separate until their shared commit", () => {
		const { reconciler, output } = setup();
		const sibling = target();
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			columnCodecs: ["pg_text"],
			target: sibling,
		});
		completeEmptyBaselineSync(reconciler);
		completeEmptyBaselineSync(reconciler, "10");
		reconciler.accept({ type: "open", publication_id: "p" });
		const first = part(0, false, "ab", 0);
		const other = part(0, false, "xy", 0);
		other.index = 1;
		other.targets = [{ live_id: "10", epoch: "1", sequence: "1" }];
		const last = part(1, true, "c", 2);
		last.index = 2;
		const otherLast = part(1, true, "z", 2);
		otherLast.index = 3;
		otherLast.targets = other.targets;
		for (const message of [first, other, last, otherLast])
			reconciler.accept(message);
		expect(output.applyBatch).not.toHaveBeenCalled();
		expect(sibling.applyBatch).not.toHaveBeenCalled();
		reconciler.accept({
			type: "commit",
			publication_id: "p",
			body_count: 4,
			frontier: { lsn: "0/1" },
		});
		expect(output.applyBatch).toHaveBeenCalledExactlyOnceWith([
			{ op: "upsert", row_key: ROW_A, values: ["abc"] },
		]);
		expect(sibling.applyBatch).toHaveBeenCalledExactlyOnceWith([
			{ op: "upsert", row_key: ROW_A, values: ["xyz"] },
		]);
	});
});
