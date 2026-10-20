import { afterEach, describe, expect, it, vi } from "vitest";

import { defined } from "../defined.test-helpers.js";
import {
	columnsDigest,
	type LiveQueryPosition,
	parseLiveQueryPosition,
} from "./position.js";
import {
	REALTIME_RESUME_SUBPROTOCOL,
	REALTIME_SUBPROTOCOL,
} from "./protocol/messages.js";
import { createRealtimeClient } from "./realtime-client.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import type { RawLiveQueryUpdate, WebSocketLike } from "./types.js";

interface TodoRow {
	readonly id: number;
	readonly title: string;
}

const FINGERPRINT = "11".repeat(32);
const OTHER_FINGERPRINT = "22".repeat(32);
const HISTORY = "ab".repeat(32);
const OTHER_HISTORY = "cd".repeat(32);
const ROW_A = "a".repeat(64);
const ROW_B = "b".repeat(64);
const COLUMNS = [
	{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
	{ name: "title", type_oid: 25, typmod: -1, codec: "pg_text" },
] as const;
const MVCC = { xmin: "1", xmax: "2", xip: [] };

type Listener = (event: { readonly data: unknown }) => void;

/** A socket whose server selects `selected` from the offered subprotocols. */
class FakeWebSocket implements WebSocketLike {
	static instances: FakeWebSocket[] = [];
	static selects: (offered: readonly string[]) => string | undefined = (
		offered,
	) => offered.at(-1);
	readyState = 0;
	protocol: string | undefined;
	readonly offered: readonly string[];
	readonly sent: Record<string, unknown>[] = [];
	private readonly listeners = new Map<string, Set<Listener>>();

	constructor(_url: string, protocols: string | string[]) {
		this.offered = typeof protocols === "string" ? [protocols] : protocols;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	close(): void {
		if (this.readyState >= 2) return;
		this.readyState = 3;
		this.emit("close", { data: undefined });
	}

	open(): void {
		this.protocol = FakeWebSocket.selects(this.offered);
		this.readyState = 1;
		this.emit("open", { data: undefined });
	}

	receive(message: object): void {
		this.emit("message", { data: JSON.stringify(message) });
	}

	subscribes(): Record<string, unknown>[] {
		return this.sent.filter((message) => message.type === "subscribe");
	}

	private emit(type: string, event: { readonly data: unknown }): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

/** Today's proxy: it only knows v1. */
const selectV1 = () => REALTIME_SUBPROTOCOL;
/** A proxy that supports resume picks it whenever it is offered. */
const selectResume = (offered: readonly string[]) =>
	offered.includes(REALTIME_RESUME_SUBPROTOCOL)
		? REALTIME_RESUME_SUBPROTOCOL
		: REALTIME_SUBPROTOCOL;

afterEach(() => {
	FakeWebSocket.instances = [];
	FakeWebSocket.selects = (offered) => offered.at(-1);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("resumable subscriptions", () => {
	it("offers the resume subprotocol only while a resumable subscription is active", () => {
		const plain = client();
		plain.subscribe(query(), { materialize: false });
		expect(socket().offered).toEqual([REALTIME_SUBPROTOCOL]);
		plain.close();

		const resumable = client();
		resumable.subscribe(query(), { materialize: false, resume: {} });
		expect(socket().offered).toEqual([
			REALTIME_RESUME_SUBPROTOCOL,
			REALTIME_SUBPROTOCOL,
		]);
		resumable.close();
	});

	it("falls back to today's baseline when the server does not negotiate resume", () => {
		FakeWebSocket.selects = selectV1;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: { from: position("0/10") },
		});
		const updates = record(subscription);
		const ws = admit();

		expect(ws.subscribes()).toHaveLength(1);
		expect(ws.subscribes()[0]).not.toHaveProperty("resume_from");
		// Today's proxy sends no continuity cursor.
		baseline(ws, [row(ROW_A, "fresh")]);

		expect(updates).toEqual([
			{
				type: "rows",
				rows: [{ rowId: ROW_A, row: { id: 1, title: "fresh" } }],
				position: undefined,
			},
		]);
		realtime.close();
	});

	it("reports the position of a baseline and advances it on every commit", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: {},
		});
		const updates = record(subscription);
		const ws = admit();
		expect(ws.subscribes()[0]).not.toHaveProperty("resume_from");

		baseline(ws, [row(ROW_A, "first")], {
			continuity: { history: HISTORY, lsn: "0/10" },
		});
		expect(updates.at(-1)).toMatchObject({ position: position("0/10") });

		commit(ws, "p1", "0/18", [
			{ op: "upsert", row_key: ROW_B, values: ["2", "second"] },
		]);
		expect(updates.at(-1)).toMatchObject({
			type: "changes",
			batch: { position: position("0/18") },
		});

		// A publication for another subscription still moves this one forward,
		// without an update.
		ws.receive({ type: "open", publication_id: "p2" });
		ws.receive({
			type: "commit",
			publication_id: "p2",
			body_count: 0,
			frontier: { lsn: "0/20" },
		});
		expect(updates).toHaveLength(2);

		ws.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(admit().subscribes()[0]?.resume_from).toMatchObject({
			lsn: "0/20",
		});
		realtime.close();
	});

	it("applies only the catch-up changes when the server confirms a resume", () => {
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: { from: position("0/10") },
		});
		const updates = record(subscription);
		const ws = admit();

		expect(ws.subscribes()[0]?.resume_from).toEqual({
			history: HISTORY,
			lsn: "0/10",
			query_fingerprint: FINGERPRINT,
			columns: columnsDigest(COLUMNS),
		});
		resumed(ws, "0/10", "0/30", [
			{ op: "upsert", row_key: ROW_A, values: ["1", "edited"] },
			{ op: "remove", row_key: ROW_B },
		]);

		expect(updates).toEqual([
			{
				type: "changes",
				changes: [
					{
						type: "upsert",
						rowId: ROW_A,
						row: { id: 1, title: "edited" },
					},
					{ type: "remove", rowId: ROW_B },
				],
				batch: { txids: [], position: position("0/30"), resumed: true },
			},
		]);
		expect(subscription.getState().status).toBe("live");
		realtime.close();
	});

	it.each([
		[
			"another database history",
			{ continuity: { history: OTHER_HISTORY, lsn: "0/5" } },
			position("0/5", OTHER_HISTORY),
		],
		[
			"a position the server can no longer continue",
			{ continuity: { history: HISTORY, lsn: "0/90" } },
			position("0/90"),
		],
		["a server that reports no continuity", {}, undefined],
	])("replaces every row when the server refuses a resume (%s)", (_reason, start, expected) => {
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: { from: position("0/10") },
		});
		const updates = record(subscription);
		const ws = admit();
		expect(ws.subscribes()[0]).toHaveProperty("resume_from");

		baseline(ws, [row(ROW_A, "authoritative")], start);

		// A complete `rows` update replaces everything the caller held, so no
		// row from before the refused resume can survive it.
		expect(updates).toEqual([
			{
				type: "rows",
				rows: [
					{ rowId: ROW_A, row: { id: 1, title: "authoritative" } },
				],
				position: expected,
			},
		]);
		realtime.close();
	});

	it.each([
		["a different query", position("0/10", HISTORY, OTHER_FINGERPRINT)],
		["a malformed stored value", { history: HISTORY, lsn: "bogus" }],
	])("does not ask to resume from %s", (_reason, from) => {
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		realtime.subscribe(query(), {
			materialize: false,
			resume: { from: from as LiveQueryPosition },
		});
		const ws = admit();
		expect(ws.subscribes()[0]).not.toHaveProperty("resume_from");
		realtime.close();
	});

	it.each([
		[
			"resume was not negotiated",
			selectV1,
			position("0/10"),
			COLUMNS,
			"0/10",
		],
		[
			"the result columns changed",
			selectResume,
			position("0/10"),
			[
				{ name: "id", type_oid: 20, typmod: -1, codec: "pg_text" },
				COLUMNS[1],
			],
			"0/10",
		],
		[
			"it continues a different position",
			selectResume,
			position("0/10"),
			COLUMNS,
			"0/8",
		],
		["nothing was requested", selectResume, undefined, COLUMNS, "0/10"],
	])("fails rather than keep unvouched rows when a resume arrives but %s", (_reason, selects, from, columns, resumeLsn) => {
		FakeWebSocket.selects = selects;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: from ? { from } : {},
		});
		const updates = record(subscription);
		const ws = admit(columns);

		resumed(ws, resumeLsn, "0/30", []);

		expect(updates).toEqual([]);
		expect(subscription.getState()).toMatchObject({
			status: "error",
			error: { code: "protocol_error" },
		});
		realtime.close();
	});

	it("rejects catch-up rows in a resumed baseline", () => {
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: { from: position("0/10") },
		});
		const ws = admit();
		ws.receive({
			type: "baseline_sync_start",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			continuity: { history: HISTORY, lsn: "0/30" },
			resume_from: { history: HISTORY, lsn: "0/10" },
			mvcc: MVCC,
		});
		ws.receive({
			type: "baseline_sync_batch",
			live_id: "41",
			epoch: "1",
			baseline_sync_attempt: "1",
			index: 0,
			rows: [row(ROW_A, "complete row")],
			changes: [],
		});
		expect(subscription.getState().status).toBe("error");
		realtime.close();
	});

	it("resumes from the latest applied position after a reconnect", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		FakeWebSocket.selects = selectResume;
		const realtime = client();
		const subscription = realtime.subscribe(query(), {
			materialize: false,
			resume: {},
		});
		const updates = record(subscription);
		const first = admit();
		baseline(first, [row(ROW_A, "first")], {
			continuity: { history: HISTORY, lsn: "0/10" },
		});
		commit(first, "p1", "0/40", [
			{ op: "upsert", row_key: ROW_A, values: ["1", "second"] },
		]);

		first.close();
		await vi.advanceTimersByTimeAsync(60_000);
		const second = admit();
		expect(second).not.toBe(first);
		expect(second.subscribes()[0]?.resume_from).toMatchObject({
			history: HISTORY,
			lsn: "0/40",
		});
		resumed(second, "0/40", "0/50", [
			{ op: "upsert", row_key: ROW_A, values: ["1", "third"] },
		]);
		expect(updates.map((update) => update.type)).toEqual([
			"rows",
			"changes",
			"changes",
		]);
		expect(updates.at(-1)).toMatchObject({
			batch: { position: position("0/50"), resumed: true },
		});
		realtime.close();
	});

	it("is limited to raw subscriptions", () => {
		const realtime = client();
		expect(() =>
			// @ts-expect-error resume requires materialize: false
			realtime.subscribe(query(), { resume: {} }),
		).toThrow("Only raw live-query subscriptions can resume");
		realtime.close();
	});
});

describe("parseLiveQueryPosition", () => {
	it("accepts a stored position and rejects anything else", () => {
		const stored = JSON.parse(JSON.stringify(position("1A/FF00")));
		expect(parseLiveQueryPosition(stored)).toEqual(position("1A/FF00"));
		for (const value of [
			undefined,
			null,
			"0/10",
			{ ...stored, lsn: "0/010" },
			{ ...stored, history: "AB".repeat(32) },
			{ ...stored, columns: undefined },
		]) {
			expect(parseLiveQueryPosition(value)).toBeUndefined();
		}
	});
});

function client() {
	return createRealtimeClient({
		url: "ws://realtime.test/v1",
		webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
	});
}

function socket(): FakeWebSocket {
	return defined(FakeWebSocket.instances.at(-1));
}

function admit(columns: readonly object[] = COLUMNS): FakeWebSocket {
	const ws = socket();
	ws.open();
	ws.receive({ type: "ready" });
	const request = defined(ws.subscribes().at(-1));
	ws.receive({
		type: "subscribed",
		request_id: request.request_id,
		live_id: "41",
		epoch: "1",
		first_sequence: "1",
		columns,
	});
	return ws;
}

function record(subscription: {
	onUpdate(listener: (update: RawLiveQueryUpdate<TodoRow>) => void): void;
}): RawLiveQueryUpdate<TodoRow>[] {
	const updates: RawLiveQueryUpdate<TodoRow>[] = [];
	subscription.onUpdate((update) => updates.push(update));
	return updates;
}

function baseline(
	ws: FakeWebSocket,
	rows: readonly object[],
	start: object = {},
): void {
	ws.receive({
		type: "baseline_sync_start",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		...start,
		mvcc: MVCC,
	});
	ws.receive({
		type: "baseline_sync_batch",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		index: 0,
		rows,
	});
	ws.receive({
		type: "baseline_sync_end",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		batch_count: 1,
	});
}

function resumed(
	ws: FakeWebSocket,
	fromLsn: string,
	toLsn: string,
	changes: readonly object[],
): void {
	ws.receive({
		type: "baseline_sync_start",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		continuity: { history: HISTORY, lsn: toLsn },
		resume_from: { history: HISTORY, lsn: fromLsn },
		mvcc: MVCC,
	});
	ws.receive({
		type: "baseline_sync_batch",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		index: 0,
		rows: [],
		changes,
	});
	ws.receive({
		type: "baseline_sync_end",
		live_id: "41",
		epoch: "1",
		baseline_sync_attempt: "1",
		batch_count: 1,
	});
}

function commit(
	ws: FakeWebSocket,
	id: string,
	lsn: string,
	changes: readonly object[],
): void {
	ws.receive({ type: "open", publication_id: id });
	ws.receive({
		type: "keyed_results",
		publication_id: id,
		index: 0,
		txids: ["7"],
		targets: [{ live_id: "41", epoch: "1", sequence: "1" }],
		changes,
	});
	ws.receive({
		type: "commit",
		publication_id: id,
		body_count: 1,
		frontier: { lsn },
	});
}

function row(rowKey: string, title: string) {
	return { row_key: rowKey, values: [rowKey === ROW_A ? "1" : "2", title] };
}

function position(
	lsn: string,
	history = HISTORY,
	queryFingerprint = FINGERPRINT,
): LiveQueryPosition {
	return {
		history,
		lsn,
		queryFingerprint,
		columns: columnsDigest(COLUMNS),
	};
}

function query(): SealedLiveQuery<TodoRow> {
	const header = Buffer.from(
		JSON.stringify({ alg: "dir", enc: "A256GCM", v: 1 }),
	).toString("base64url");
	return {
		capability: `${header}..iv.ciphertext.tag`,
		queryFingerprint: FINGERPRINT,
		expiresAt: Date.now() + 60_000,
	};
}
