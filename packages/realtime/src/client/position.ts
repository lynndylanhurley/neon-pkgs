import type {
	ContinuityCursor,
	ResumePosition,
	WireColumn,
} from "./protocol/messages.js";

/**
 * A fully applied point in a live query's synchronized result.
 *
 * The value is JSON-compatible so it can be stored next to the rows it
 * describes. It identifies the database history and PostgreSQL LSN the rows
 * reflect, plus the exact query and result columns they were decoded under.
 * Persist it in the same transaction as those rows; a position saved ahead of
 * its rows would let a resume skip changes.
 */
export interface LiveQueryPosition {
	/** Opaque database-history identity, as 64 lowercase hex characters. */
	readonly history: string;
	/** PostgreSQL LSN, such as `0/16B3748`, through which changes are applied. */
	readonly lsn: string;
	/** Fingerprint of the sealed query whose rows this position describes. */
	readonly queryFingerprint: string;
	/** Digest of the result columns the rows were decoded with. */
	readonly columns: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const PG_LSN = /^(0|[1-9A-F][0-9A-F]{0,7})\/(0|[1-9A-F][0-9A-F]{0,7})$/;

/**
 * Validate a stored position.
 *
 * @returns A frozen position, or `undefined` for anything else, so a corrupt or
 * outdated stored value falls back to a complete baseline.
 */
export function parseLiveQueryPosition(
	value: unknown,
): LiveQueryPosition | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { history, lsn, queryFingerprint, columns } = value as Record<
		string,
		unknown
	>;
	if (
		typeof history !== "string" ||
		!HEX_64.test(history) ||
		typeof lsn !== "string" ||
		!PG_LSN.test(lsn) ||
		typeof queryFingerprint !== "string" ||
		!HEX_64.test(queryFingerprint) ||
		typeof columns !== "string" ||
		!HEX_16.test(columns)
	)
		return undefined;
	return Object.freeze({ history, lsn, queryFingerprint, columns });
}

export function positionAt(
	cursor: ContinuityCursor,
	queryFingerprint: string,
	columns: string,
): LiveQueryPosition {
	return Object.freeze({
		history: cursor.history,
		lsn: cursor.lsn,
		queryFingerprint,
		columns,
	});
}

/** Return `position` advanced to `lsn`, never moving it backwards. */
export function advancePosition(
	position: LiveQueryPosition,
	lsn: string,
): LiveQueryPosition {
	if (parsePgLsn(lsn) <= parsePgLsn(position.lsn)) return position;
	return Object.freeze({ ...position, lsn });
}

export function toResumePosition(position: LiveQueryPosition): ResumePosition {
	return {
		history: position.history,
		lsn: position.lsn,
		query_fingerprint: position.queryFingerprint,
		columns: position.columns,
	};
}

/** Whether `position` is exactly the cursor a resumed baseline continues. */
export function positionMatches(
	position: LiveQueryPosition,
	cursor: ContinuityCursor,
): boolean {
	return position.history === cursor.history && position.lsn === cursor.lsn;
}

/** Whether `continuity` is at or after `from` in the same database history. */
export function continuesFrom(
	continuity: ContinuityCursor,
	from: ContinuityCursor,
): boolean {
	return (
		continuity.history === from.history &&
		parsePgLsn(continuity.lsn) >= parsePgLsn(from.lsn)
	);
}

/**
 * Digest result columns so a resume is refused after the result shape changes.
 *
 * FNV-1a 64 over the UTF-8 JSON of `[[name, type_oid, typmod, codec], ...]`.
 * It detects change; it is not a security boundary. The schema documents the
 * same construction for the proxy.
 */
export function columnsDigest(columns: readonly WireColumn[]): string {
	const canonical = JSON.stringify(
		columns.map((column) => [
			column.name,
			column.type_oid,
			column.typmod,
			column.codec,
		]),
	);
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(canonical)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

function parsePgLsn(value: string): bigint {
	const [upper, lower] = value.split("/");
	if (upper === undefined || lower === undefined) {
		throw new Error("Invalid PostgreSQL LSN");
	}
	return (BigInt(`0x${upper}`) << 32n) | BigInt(`0x${lower}`);
}
