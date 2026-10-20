import type { Column, ServerMessage } from "./wire-types.gen.js";

export const REALTIME_SUBPROTOCOL = "neon.realtime.v1";
/**
 * v1 plus resumable subscriptions. Offered ahead of v1 only while a resumable
 * subscription is active, and `resume_from` is sent only when the server
 * selected it, so a proxy without resume support keeps receiving plain v1.
 */
export const REALTIME_RESUME_SUBPROTOCOL = "neon.realtime.v1+resume";

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
	ContinuityCursor,
	Mvcc as MvccSnapshot,
	ResetTarget,
	ResumePosition,
	Row as WireRow,
	ServerMessage,
} from "./wire-types.gen.js";
