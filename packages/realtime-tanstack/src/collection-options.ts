import {
	type LiveQueryBatchInfo,
	type LiveQueryChange,
	type LiveQueryPosition,
	type LiveQueryState,
	parseLiveQueryPosition,
	QueryRefreshController,
	type RawLiveQueryRow,
	type RawLiveQuerySubscription,
	type RealtimeClient,
	type SealedLiveQuery,
} from "@neon/realtime/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	BaseCollectionConfig,
	CollectionConfig,
	SyncAppliedReceipt,
	SyncMetadataApi,
	UtilsRecord,
} from "@tanstack/db";
import { withCollectionConfigFactory } from "@tanstack/db";
import type { NoInferCompat } from "./no-infer.js";

/** Utilities attached to a Realtime-backed TanStack DB collection. */
export interface RealtimeCollectionUtils extends UtilsRecord {
	/**
	 * Wait until this query has processed a known committed PostgreSQL transaction.
	 * Covered row changes enter TanStack DB's causal sync queue before this resolves.
	 *
	 * @remarks
	 * This does not determine whether a transaction committed, so pass only IDs
	 * from transactions known to have committed.
	 *
	 * @param txid - PostgreSQL transaction ID as a decimal string.
	 * @param timeout - Optional maximum wait in milliseconds. By default, the
	 * promise remains pending until the transaction arrives or the collection is
	 * cleaned up.
	 * @throws If a supplied timeout elapses or the collection is cleaned up.
	 */
	awaitTxId(txid: string, timeout?: number): Promise<boolean>;
}

/**
 * Configuration for a Realtime-backed TanStack DB collection.
 *
 * The adapter owns `sync`, uses eager synchronization, and supplies its own
 * collection utilities.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export interface RealtimeCollectionConfig<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
> extends Omit<
		BaseCollectionConfig<Row, Key, Schema, RealtimeCollectionUtils, void>,
		"syncMode" | "utils"
	> {
	/** Reusable low-level Realtime client. */
	readonly client: RealtimeClient;
	/** Initial query for the exact query backing this collection. */
	readonly query: SealedLiveQuery<Row>;
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	/** Derive the stable unique TanStack DB key for a row. */
	readonly getKey: (row: Row) => Key;
	/**
	 * Resume from the rows the collection already holds instead of downloading
	 * the complete result again on every start and reconnect.
	 *
	 * The adapter stores the Realtime position and row identities in TanStack
	 * DB sync metadata, in the same transaction as the rows they describe, so a
	 * persisted collection resumes after a restart. When the server cannot
	 * confirm continuity (another database history, a position too old, a
	 * changed query or result shape, or a server without resume support), the
	 * collection is reset from a complete baseline exactly as without this
	 * option.
	 *
	 * @defaultValue `false`
	 */
	readonly resume?: boolean;
}

/**
 * TanStack DB collection options produced by {@link realtimeCollectionOptions}.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key for a collection row.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export type RealtimeCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
> = Omit<
	CollectionConfig<Row, Key, Schema, RealtimeCollectionUtils>,
	"utils"
> & {
	/** Realtime-specific transaction-confirmation utility. */
	readonly utils: RealtimeCollectionUtils;
};

/**
 * Create TanStack DB collection options backed by a raw live-query subscription.
 * Complete-row replacements and committed change batches are applied atomically.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 * @param config - Live-query subscription settings and ordinary TanStack DB
 * collection options.
 * @returns Collection options to pass to TanStack DB's `createCollection()`.
 */
export function realtimeCollectionOptions<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
>(
	// Infer rows from the query, then check collection options against that type.
	config: RealtimeCollectionConfig<NoInferCompat<Row>, Key, Schema> & {
		readonly query: SealedLiveQuery<Row>;
	},
): RealtimeCollectionOptions<Row, Key, Schema> {
	const createOptions = () => createRealtimeCollectionOptions(config);
	return withCollectionConfigFactory(createOptions(), createOptions);
}

function createRealtimeCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
>(
	config: RealtimeCollectionConfig<Row, Key, Schema>,
): RealtimeCollectionOptions<Row, Key, Schema> {
	const {
		client,
		query: initialQuery,
		refreshQuery,
		resume = false,
		...baseConfig
	} = config;
	let activeSubscription: RawLiveQuerySubscription<Row> | undefined;
	const utils: RealtimeCollectionUtils = Object.freeze({
		awaitTxId: async (txid, timeout) => {
			const subscription = activeSubscription;
			if (!subscription) {
				throw new Error("Realtime collection is not syncing");
			}
			try {
				await subscription.awaitTxId(txid, timeout);
			} catch (error) {
				if (activeSubscription !== subscription) {
					throw new Error("Realtime collection was cleaned up", {
						cause: error,
					});
				}
				throw error;
			}
			return true;
		},
	});

	const options: RealtimeCollectionOptions<Row, Key, Schema> = {
		...baseConfig,
		syncMode: "eager",
		utils,
		sync: {
			rowUpdateMode: "full",
			sync: ({
				begin,
				write,
				commit,
				truncate,
				markReady,
				markError,
				metadata,
			}) => {
				let cleaned = false;
				// Without sync metadata there is nowhere to keep a position next to
				// the rows, so every start is a complete baseline.
				const resumeStore =
					resume && metadata ? metadata.collection : undefined;
				const stored = resumeStore
					? loadResumeState<Key>(
							resumeStore,
							initialQuery.queryFingerprint,
						)
					: undefined;
				let rowIds = stored?.rowIds ?? new Map<string, Key>();
				let keys = new Map<Key, string>(
					[...rowIds].map(([rowId, key]) => [key, rowId]),
				);
				const subscription = client.subscribe(initialQuery, {
					materialize: false,
					...(resumeStore
						? { resume: { from: stored?.position } }
						: {}),
				});
				activeSubscription = subscription;

				const reportError = (error: unknown) => {
					if (!cleaned) markError(error);
				};
				const queryRefresh = new QueryRefreshController({
					query: initialQuery,
					refreshQuery,
					renewSubscription: (replacement) =>
						subscription.renew(replacement),
					onRefreshExhausted: reportError,
					subscription,
				});
				const observeReceipt = (
					receipt: SyncAppliedReceipt,
					onApplied?: () => void,
				) => {
					if (receipt === true) {
						onApplied?.();
					} else {
						void receipt.then(
							() => {
								if (!cleaned) onApplied?.();
							},
							(error) => reportError(error),
						);
					}
				};

				const installReset = (
					rows: readonly RawLiveQueryRow<Row>[],
					position: LiveQueryPosition | undefined,
				) => {
					try {
						const nextRowIds = new Map<string, Key>();
						const nextKeys = new Map<Key, string>();
						for (const { rowId, row } of rows) {
							const key = config.getKey(row);
							if (nextRowIds.has(rowId)) {
								throw new Error(
									`Duplicate Realtime row ID: ${rowId}`,
								);
							}
							if (nextKeys.has(key)) {
								throw new Error(
									`Duplicate TanStack collection key: ${String(key)}`,
								);
							}
							nextRowIds.set(rowId, key);
							nextKeys.set(key, rowId);
						}

						begin();
						truncate();
						for (const { row } of rows)
							write({ type: "insert", value: row });
						if (resumeStore) {
							// `list()` sees applied metadata and only the newest pending
							// transaction. Identities written by earlier commits that are
							// still queued are in `rowIds`, so clear both.
							const stale = new Set<string>();
							for (const { key } of resumeStore.list(ROW_PREFIX))
								stale.add(key);
							for (const rowId of rowIds.keys())
								stale.add(ROW_PREFIX + rowId);
							for (const key of stale) resumeStore.delete(key);
							for (const [rowId, key] of nextRowIds)
								resumeStore.set(ROW_PREFIX + rowId, key);
							savePosition(resumeStore, position);
						} else if (
							metadata?.collection.get(POSITION_KEY) !== undefined
						) {
							// A position stored while resume was enabled no longer
							// describes these rows. Drop it so re-enabling resume
							// starts from a baseline; leftover identities are cleared
							// by that baseline.
							metadata.collection.delete(POSITION_KEY);
						}
						const receipt = commit();
						rowIds = nextRowIds;
						keys = nextKeys;
						observeReceipt(receipt, markReady);
					} catch (error) {
						reportError(error);
					}
				};

				const applyBatch = (
					changes: readonly LiveQueryChange<Row>[],
					batch: LiveQueryBatchInfo,
				) => {
					try {
						const nextRowIds = new Map(rowIds);
						const nextKeys = new Map(keys);
						const writes: Array<
							| { type: "insert" | "update"; value: Row }
							| { type: "delete"; key: Key }
						> = [];

						for (const change of changes) {
							if (change.type === "upsert") {
								const key = config.getKey(change.row);
								const previousKey = nextRowIds.get(
									change.rowId,
								);
								const keyOwner = nextKeys.get(key);
								if (
									keyOwner !== undefined &&
									keyOwner !== change.rowId
								) {
									throw new Error(
										`Realtime upserted an existing key: ${String(key)}`,
									);
								}
								if (previousKey === undefined) {
									nextRowIds.set(change.rowId, key);
									nextKeys.set(key, change.rowId);
									writes.push({
										type: "insert",
										value: change.row,
									});
								} else if (key !== previousKey) {
									nextKeys.delete(previousKey);
									nextKeys.set(key, change.rowId);
									nextRowIds.set(change.rowId, key);
									writes.push({
										type: "delete",
										key: previousKey,
									});
									writes.push({
										type: "insert",
										value: change.row,
									});
								} else {
									writes.push({
										type: "update",
										value: change.row,
									});
								}
							} else {
								const key = nextRowIds.get(change.rowId);
								if (key === undefined) {
									throw new Error(
										`Realtime deleted an unknown row ID: ${change.rowId}`,
									);
								}
								nextRowIds.delete(change.rowId);
								nextKeys.delete(key);
								writes.push({ type: "delete", key });
							}
						}

						begin();
						for (const message of writes) write(message);
						if (resumeStore) {
							for (const change of changes) {
								const key = nextRowIds.get(change.rowId);
								if (key === undefined)
									resumeStore.delete(
										ROW_PREFIX + change.rowId,
									);
								else
									resumeStore.set(
										ROW_PREFIX + change.rowId,
										key,
									);
							}
							savePosition(resumeStore, batch.position);
						}
						const receipt = commit();
						rowIds = nextRowIds;
						keys = nextKeys;
						// A confirmed resume is the first authoritative state, like a reset.
						observeReceipt(
							receipt,
							batch.resumed ? markReady : undefined,
						);
					} catch (error) {
						reportError(error);
					}
				};

				const stateChanged = (state: LiveQueryState) => {
					if (state.status === "error") markError(state.error);
					// Initial connecting maps to loading; complete rows make the
					// collection ready. Reconnection and stale capability states retain
					// an already-ready collection, while closed uses normal sync cleanup.
				};

				const unsubscribeUpdate = subscription.onUpdate((update) => {
					if (update.type === "rows")
						installReset(update.rows, update.position);
					else applyBatch(update.changes, update.batch);
				});
				const unsubscribeState =
					subscription.onStateChange(stateChanged);
				queryRefresh.start();

				return () => {
					cleaned = true;
					queryRefresh.stop();
					unsubscribeUpdate();
					unsubscribeState();
					subscription.unsubscribe();
					if (activeSubscription === subscription) {
						activeSubscription = undefined;
					}
					rowIds.clear();
					keys.clear();
				};
			},
		},
	};

	return options;
}

const POSITION_KEY = "realtime:position";
const ROW_PREFIX = "realtime:row:";

type CollectionMetadata = SyncMetadataApi["collection"];

/**
 * Read the stored position and the row identities it covers. Anything
 * missing, malformed, or recorded for another query yields no position, and
 * the next baseline replaces whatever the collection holds.
 */
function loadResumeState<Key extends string | number>(
	store: CollectionMetadata,
	queryFingerprint: string,
):
	| {
			readonly position: LiveQueryPosition | undefined;
			readonly rowIds: Map<string, Key>;
	  }
	| undefined {
	const position = parseLiveQueryPosition(store.get(POSITION_KEY));
	if (!position || position.queryFingerprint !== queryFingerprint) {
		return undefined;
	}
	const rowIds = new Map<string, Key>();
	for (const { key, value } of store.list(ROW_PREFIX)) {
		if (typeof value !== "string" && typeof value !== "number") {
			return undefined;
		}
		rowIds.set(key.slice(ROW_PREFIX.length), value as Key);
	}
	return { position, rowIds };
}

function savePosition(
	store: CollectionMetadata,
	position: LiveQueryPosition | undefined,
): void {
	if (position) store.set(POSITION_KEY, position);
	else store.delete(POSITION_KEY);
}
