import {
	type ConnectionCallbacks,
	ConnectionCoordinator,
	ConnectionCoordinatorError,
	type ConnectionHandle,
	type WebSocketFactory,
} from "./connection/coordinator.js";
import {
	type ClientEventSink,
	createClientEventSink,
	registerSubscriptionEvents,
} from "./diagnostics.js";
import type { NoInferCompat } from "./no-infer.js";
import {
	createParserRegistry,
	type PostgreSQLParserRegistry,
} from "./postgres/parsers.js";
import {
	type SealedLiveQuery,
	sealedQueryEnvelopeVersion,
	validateSealedQuery,
} from "./sealed-query.js";
import { Subscription } from "./subscription.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeClientOptions,
} from "./types.js";

export type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryError,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeClientOptions,
	RealtimeLogEntry,
	RealtimeLogEvent,
	RealtimeLogger,
	RealtimeLogLevel,
} from "./types.js";

interface PendingAdmission {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
}

interface CallbackGate {
	run(callback: () => void): void;
	open(): void;
}

interface SubscriptionBinding {
	readonly handle: ConnectionHandle;
	readonly events: ReturnType<ClientEventSink["createSubscription"]>;
	readonly admission?: PendingAdmission;
}

class RealtimeClientImpl implements RealtimeClient {
	private readonly coordinator: ConnectionCoordinator;
	private readonly handles = new Map<
		Subscription<unknown>,
		SubscriptionBinding
	>();
	private disposed = false;
	private readonly parsers: PostgreSQLParserRegistry;
	private readonly events: ClientEventSink;

	constructor(
		options: RealtimeClientOptions,
		webSocketFactory?: WebSocketFactory,
	) {
		this.events = createClientEventSink(options);
		this.coordinator = new ConnectionCoordinator({
			url: options.url,
			events: this.events,
			webSocketFactory,
		});
		this.parsers = createParserRegistry(options.parsers);
	}

	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?: MaterializedLiveQueryOptions<NoInferCompat<Row>>,
	): MaterializedLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?:
			| MaterializedLiveQueryOptions<NoInferCompat<Row>>
			| RawLiveQueryOptions,
	): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
		if (this.disposed) throw new Error("Realtime client is closed");
		validateSealedQuery(query);
		const materialized = options?.materialize !== false;
		const events = this.events.createSubscription();
		const initialData = materialized
			? (options as MaterializedLiveQueryOptions<Row> | undefined)
					?.initialData
			: undefined;
		const subscription = new Subscription(
			this,
			query,
			materialized,
			this.parsers,
			initialData,
			events,
		);
		registerSubscriptionEvents(subscription, events);
		const handle = this.createConnectionHandle(subscription, query, events);
		this.handles.set(subscription as Subscription<unknown>, {
			handle,
			events,
		});
		return subscription;
	}

	async renew<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
	): Promise<void> {
		validateSealedQuery(query);
		const binding = this.handles.get(subscription as Subscription<unknown>);
		if (!binding) throw new Error("Live-query subscription is closed");
		try {
			if (
				sealedQueryEnvelopeVersion(subscription.currentQuery()) !==
				sealedQueryEnvelopeVersion(query)
			) {
				await this.replaceConnectionHandle(
					subscription,
					query,
					binding,
				);
				return;
			}
			await binding.handle.renew(query);
			subscription.replaceSealedQuery(query);
		} catch (error) {
			const state = subscription.getState();
			if (
				state.status !== "closed" &&
				(!(error instanceof ConnectionCoordinatorError) ||
					error.retryable)
			) {
				subscription.renewalFailed(error);
			}
			throw error;
		}
	}

	unsubscribe<Row>(subscription: Subscription<Row>): void {
		const binding = this.handles.get(subscription as Subscription<unknown>);
		if (!binding) return;
		this.handles.delete(subscription as Subscription<unknown>);
		binding.admission?.reject(
			new Error("Live-query subscription is closed"),
		);
		binding.handle.unsubscribe();
		subscription.markClosed();
	}

	parserFailed<Row>(subscription: Subscription<Row>, cause: Error): void {
		const binding = this.handles.get(subscription as Subscription<unknown>);
		if (!binding) return;
		binding.handle.fail(
			new ConnectionCoordinatorError(
				"parser_error",
				false,
				cause.message,
				{ cause: cause.cause },
			),
		);
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [subscription, binding] of this.handles) {
			binding.admission?.reject(new Error("Realtime client is closed"));
			subscription.markClosed();
		}
		this.handles.clear();
		this.coordinator.close();
		this.events.closed();
	}

	private connectionCallbacks<Row>(
		subscription: Subscription<Row>,
		events: ReturnType<ClientEventSink["createSubscription"]>,
		admission?: PendingAdmission,
		gate?: CallbackGate,
	): ConnectionCallbacks {
		const deliver = (callback: () => void): void =>
			gate ? gate.run(callback) : callback();
		return {
			events,
			reconciliation: subscription,
			admitted: (columns) =>
				deliver(() => {
					subscription.admit(columns);
					admission?.resolve();
				}),
			connecting: () => deliver(() => subscription.connecting()),
			queryUnavailable: (error) =>
				deliver(() => {
					admission?.reject(error);
					subscription.queryUnavailable();
				}),
			failed: (error) =>
				deliver(() => {
					admission?.reject(error);
					subscription.fail(error);
				}),
		};
	}

	private createConnectionHandle<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
		events: ReturnType<ClientEventSink["createSubscription"]>,
	): ConnectionHandle {
		return this.coordinator.subscribe(
			query,
			this.connectionCallbacks(subscription, events),
		);
	}

	private replaceConnectionHandle<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
		previous: SubscriptionBinding,
	): Promise<void> {
		const admission = pendingAdmission();
		const gate = callbackGate();
		const handle = previous.handle.replace(
			query,
			this.connectionCallbacks(
				subscription,
				previous.events,
				admission,
				gate,
			),
		);
		this.handles.set(subscription as Subscription<unknown>, {
			handle,
			events: previous.events,
			admission,
		});
		previous.admission?.reject(
			new ConnectionCoordinatorError(
				"renewal_superseded",
				false,
				"Live-query renewal was superseded by a newer sealed query",
			),
		);
		subscription.replaceSealedQuery(query);
		subscription.connecting();
		gate.open();
		return admission.promise;
	}
}

function callbackGate(): CallbackGate {
	let open = false;
	const pending: (() => void)[] = [];
	return {
		run: (callback) => {
			if (open) callback();
			else pending.push(callback);
		},
		open: () => {
			if (open) return;
			open = true;
			for (const callback of pending) callback();
			pending.length = 0;
		},
	};
}

function pendingAdmission(): PendingAdmission {
	let settled = false;
	let resolvePromise!: () => void;
	let rejectPromise!: (error: unknown) => void;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: () => {
			if (settled) return;
			settled = true;
			resolvePromise();
		},
		reject: (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		},
	};
}

/**
 * Create a reusable client that lazily opens and multiplexes a Realtime
 * WebSocket connection that is bound by its first accepted query capability.
 *
 * The connection carries no user session credential; each subscription sends
 * its own short-lived sealed query. Idle connections are heartbeat-probed,
 * and recoverable disconnects retry with capped jittered backoff until the
 * connection recovers or the client is closed.
 *
 * @param options - Browser client configuration, including the proxy WebSocket
 * URL.
 * @returns A client that opens its connection when the first query subscribes.
 */
export function createRealtimeClient(
	options: RealtimeClientOptions,
): RealtimeClient {
	return new RealtimeClientImpl(options);
}

/** @internal Node direct subscriptions supply a terminable WebSocket. */
export function createRealtimeClientInternal(
	options: RealtimeClientOptions,
	webSocketFactory: WebSocketFactory,
): RealtimeClient {
	return new RealtimeClientImpl(options, webSocketFactory);
}
