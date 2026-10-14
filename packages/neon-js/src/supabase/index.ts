import {
	SupabaseAuthAdapter,
	type SupabaseAuthAdapterInstance,
} from "@neon/auth/vanilla/adapters";
import {
	type CreateClientDataApiConfig,
	type CreateClientResult,
	createClientImpl,
} from "../client/client-factory";
import type { DeriveNeonUrls } from "../client/derive-urls";
import type { DefaultSchemaName, NeonClient } from "../client/neon-client";

type SupabaseAuthConfig = {
	/** The auth service URL */
	url: string;
	/** Fall back to an anonymous token when there is no user session. */
	allowAnonymous?: boolean;
};

type SupabaseDataApiConfig<SchemaName> = CreateClientDataApiConfig<
	SchemaName,
	SupabaseAuthAdapterInstance
>;

/** Configuration for the Supabase-compatible `createClient`. */
export type CreateSupabaseClientConfig<SchemaName> = {
	auth: SupabaseAuthConfig;
	dataApi: SupabaseDataApiConfig<SchemaName>;
};

/** Per-call overrides accepted alongside a single base URL. */
export type CreateSupabaseClientStringOptions<SchemaName> = {
	auth?: Partial<SupabaseAuthConfig>;
	dataApi?: Partial<SupabaseDataApiConfig<SchemaName>>;
	deriveUrls?: DeriveNeonUrls;
};

/**
 * `createClient` with the auth adapter fixed to `SupabaseAuthAdapter`, so `client.auth`
 * has the Supabase-compatible API (`signInWithPassword`, `onAuthStateChange`, ...).
 *
 * @example
 * ```typescript
 * import { createClient } from '@neon/neon-js/supabase';
 *
 * const client = createClient({
 *   auth: { url: 'https://auth.example.com' },
 *   dataApi: { url: 'https://data-api.example.com/rest/v1' },
 * });
 *
 * await client.auth.signInWithPassword({ email, password });
 * const { data: items } = await client.from('items').select();
 * ```
 */
export function createClient<Database = any>(
	config: CreateSupabaseClientConfig<DefaultSchemaName<Database>>,
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;
export function createClient<Database = any>(
	baseUrl: string,
	options?: CreateSupabaseClientStringOptions<DefaultSchemaName<Database>>,
): CreateClientResult<Database, SupabaseAuthAdapterInstance>;
export function createClient<
	Database = any,
	SchemaName extends string & keyof Database = DefaultSchemaName<Database>,
>(
	arg1: string | CreateSupabaseClientConfig<SchemaName>,
	arg2?: CreateSupabaseClientStringOptions<SchemaName>,
): NeonClient<Database, SchemaName, SupabaseAuthAdapterInstance> {
	const adapter = SupabaseAuthAdapter();
	// An `auth` block is always present here, so the implementation never takes its
	// external-auth branch and the result always carries `.auth`.
	const client =
		typeof arg1 === "string"
			? createClientImpl<
					Database,
					SchemaName,
					SupabaseAuthAdapterInstance
				>(arg1, { ...arg2, auth: { ...arg2?.auth, adapter } })
			: createClientImpl<
					Database,
					SchemaName,
					SupabaseAuthAdapterInstance
				>({
					...arg1,
					auth: { ...arg1.auth, adapter },
				});
	return client as NeonClient<
		Database,
		SchemaName,
		SupabaseAuthAdapterInstance
	>;
}
