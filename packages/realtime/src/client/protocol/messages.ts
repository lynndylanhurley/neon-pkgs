import type { Column, ServerMessage } from "./wire-types-v2.gen.js";

export const REALTIME_SUBPROTOCOL = "neon.realtime.v1";
export const REALTIME_FRAGMENT_SUBPROTOCOL = "neon.realtime.v2";
export const MAX_FRAGMENT_BYTES = 65_536;
export const MAX_FRAGMENT_PIECES = 256;
export type { ServerMessage } from "./wire-types-v2.gen.js";

type ServerVariant<Type extends ServerMessage["type"]> = Extract<
	ServerMessage,
	{ type: Type }
>;

export type ColumnCodec = Column["codec"];
export type SubscribeRejectionCode =
	ServerVariant<"subscribe_rejected">["code"];
export type SubscriptionErrorCode = ServerVariant<"subscription_error">["code"];
export type ConnectionErrorCode = ServerVariant<"connection_error">["code"];

export type {
	Cell as WireCell,
	Change as WireChange,
	ChangeTarget,
	ClientMessage,
	Column as WireColumn,
	Mvcc as MvccSnapshot,
	ResetTarget,
	Row as WireRow,
} from "./wire-types.gen.js";
