import { ProtocolError } from "../protocol/codec.js";
import {
	type ColumnCodec,
	MAX_FRAGMENT_BYTES,
	type WireCell,
	type WireRow,
} from "../protocol/messages.js";
import type { RowPiece } from "../protocol/wire-types-v2.gen.js";

const MAX_U64 = (1n << 64n) - 1n;

/** Tracks one unfinished row. Only received bytes allocate, never declared totals. */
export class RowAssembler {
	private rowIndex: bigint;
	private rowKey?: string;
	private column = 0;
	private offset = 0n;
	private total?: bigint;
	private values: WireCell[] = [];
	private decoder?: TextDecoder;
	private textParts: string[] = [];
	private binaryParts: Uint8Array[] = [];

	constructor(
		private readonly codecs: readonly ColumnCodec[],
		firstRow = 0n,
	) {
		if (codecs.length === 0 || codecs.length > 256)
			throw new ProtocolError("fragment column count");
		this.rowIndex = firstRow;
	}

	accept(piece: RowPiece): WireRow | undefined {
		const rowIndex = byteCount(piece.row_index);
		const offset = byteCount(piece.offset);
		const total = byteCount(piece.total_bytes);
		if (
			rowIndex !== this.rowIndex ||
			piece.column_index !== this.column ||
			offset !== this.offset
		) {
			throw new ProtocolError("fragment row, column or offset order");
		}
		if (
			(this.rowKey !== undefined && this.rowKey !== piece.row_key) ||
			(this.total !== undefined && this.total !== total)
		) {
			throw new ProtocolError("fragment identity or total changed");
		}
		if (
			piece.is_null &&
			(offset !== 0n || total !== 0n || piece.base64 !== "")
		) {
			throw new ProtocolError("null fragment has data");
		}
		const bytes = decodePiece(piece.base64);
		const end = offset + BigInt(bytes.length);
		if (end > total || (total !== 0n && bytes.length === 0)) {
			throw new ProtocolError("fragment length or progress");
		}
		this.rowKey = piece.row_key;
		this.total = total;
		this.offset = end;
		const codec = this.codecs[this.column];
		if (!piece.is_null) {
			if (codec === "pg_text") {
				this.decoder ??= new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				});
				try {
					const text = this.decoder.decode(bytes, {
						stream: end !== total,
					});
					if (text !== "") this.textParts.push(text);
				} catch {
					throw new ProtocolError("fragment contains invalid UTF-8");
				}
			} else {
				this.binaryParts.push(bytes);
			}
		}
		if (end !== total) return undefined;
		this.values.push(
			piece.is_null
				? null
				: codec === "pg_text"
					? this.textParts.join("")
					: { base64: encodeBinary(this.binaryParts) },
		);
		this.offset = 0n;
		this.total = undefined;
		this.decoder = undefined;
		this.textParts = [];
		this.binaryParts = [];
		this.column += 1;
		if (this.column !== this.codecs.length) return undefined;
		if (this.rowIndex === MAX_U64)
			throw new ProtocolError("fragment row index overflow");
		Object.freeze(this.values);
		const row = Object.freeze({
			row_key: this.rowKey,
			values: this.values,
		});
		this.rowIndex += 1n;
		this.rowKey = undefined;
		this.column = 0;
		this.values = [];
		return row;
	}

	acceptWhole(row: WireRow): void {
		this.finish();
		if (row.values.length !== this.codecs.length)
			throw new ProtocolError("fragment row arity");
		this.advanceRow();
	}

	remove(rowIndex: string): void {
		this.finish();
		if (byteCount(rowIndex) !== this.rowIndex)
			throw new ProtocolError("fragment remove order");
		this.advanceRow();
	}

	finish(): void {
		if (this.rowKey !== undefined)
			throw new ProtocolError("incomplete fragment row");
	}

	private advanceRow(): void {
		if (this.rowIndex === MAX_U64)
			throw new ProtocolError("fragment row index overflow");
		this.rowIndex += 1n;
	}
}

function byteCount(text: string): bigint {
	if (!/^(0|[1-9][0-9]*)$/u.test(text))
		throw new ProtocolError("invalid fragment byte count");
	const value = BigInt(text);
	if (value > MAX_U64)
		throw new ProtocolError("fragment byte count overflow");
	return value;
}

function decodePiece(base64: string): Uint8Array {
	if (base64.length > 87_384)
		throw new ProtocolError("fragment payload limit");
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw new ProtocolError("invalid fragment base64");
	}
	if (binary.length > MAX_FRAGMENT_BYTES || btoa(binary) !== base64) {
		throw new ProtocolError("noncanonical or oversized fragment base64");
	}
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// Preserve the existing complete wire-cell API without a second full binary
// buffer. Re-encode decoded bytes in aligned groups; only the final group is
// padded. Concatenating the original independently padded pieces is incorrect.
function encodeBinary(chunks: Uint8Array[]): string {
	const encoded: string[] = [];
	let remainder = new Uint8Array();
	for (const [index, chunk] of chunks.entries()) {
		const joined = new Uint8Array(remainder.length + chunk.length);
		joined.set(remainder);
		joined.set(chunk, remainder.length);
		const end = joined.length - (joined.length % 3);
		const strings: string[] = [];
		for (let start = 0; start < end; start += 8192) {
			strings.push(
				String.fromCharCode(
					...joined.subarray(start, Math.min(start + 8192, end)),
				),
			);
		}
		if (end !== 0) encoded.push(btoa(strings.join("")));
		remainder = joined.slice(end);
		chunks[index] = new Uint8Array();
	}
	if (remainder.length !== 0)
		encoded.push(btoa(String.fromCharCode(...remainder)));
	return encoded.join("");
}
