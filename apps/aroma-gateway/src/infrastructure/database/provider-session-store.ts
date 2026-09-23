import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {nowInstant, toInstant} from "@coffee-platform/platform-time";
import {withTransaction, type Database, type SqlScalar} from "@coffee-platform/database";
import {defineStatement, type OwnerStatement} from "@coffee-platform/database/owner";
import {deserializeCookieMaterial, serializeCookieMaterial, type ProviderCookie} from "../provider/cookie-jar.js";

const SESSION_VERSION = Buffer.from("ps1", "ascii");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HASH = /^[a-f0-9]{64}$/u;

type ProviderSessionRow = Readonly<{encrypted_cookie_material: unknown; expires_at: unknown; updated_at: unknown}>;

export type StoredProviderSession = Readonly<{
  encryptedCookieMaterial: Uint8Array;
  expiresAt: string | null;
  storedAt: string;
}>;

export interface ProviderSessionStore {
  load(scopeHash: string, signal?: AbortSignal): Promise<StoredProviderSession | undefined>;
  save(scopeHash: string, encryptedCookieMaterial: Uint8Array, expiresAt: string | null, signal?: AbortSignal): Promise<void>;
  delete(scopeHash: string, signal?: AbortSignal): Promise<void>;
}

function validKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new TypeError("provider session encryption key must be 32 bytes");
  return Buffer.from(key);
}

function validScopeHash(scopeHash: string): void {
  if (!HASH.test(scopeHash)) throw new TypeError("provider session scope hash is invalid");
}

function validExpiry(expiresAt: string | null): void {
  if (expiresAt !== null) { try { toInstant(expiresAt); } catch { throw new TypeError("provider session expiry is invalid"); } }
}

export function providerSessionScopeHash(scopeRef: string, email: string): string {
  if (typeof scopeRef !== "string" || scopeRef.length === 0 || scopeRef.length > 128 || !scopeRef.isWellFormed() || scopeRef.includes("\u0000") ||
    typeof email !== "string" || email.length === 0 || !email.isWellFormed()) throw new TypeError("provider session scope is invalid");
  return createHash("sha256").update(`${scopeRef}\u0000${email}`).digest("hex");
}

/** AES-GCM envelope. The database receives this opaque envelope only. */
export function encryptCookieMaterial(cookies: readonly ProviderCookie[], key: Uint8Array): Uint8Array {
  const encryptionKey = validKey(key);
  const plaintext = Buffer.from(serializeCookieMaterial(cookies), "utf8");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  return new Uint8Array(Buffer.concat([SESSION_VERSION, nonce, tag, ciphertext]));
}

export function decryptCookieMaterial(encrypted: Uint8Array, key: Uint8Array): readonly ProviderCookie[] {
  const encryptionKey = validKey(key);
  if (!(encrypted instanceof Uint8Array) || encrypted.byteLength <= SESSION_VERSION.length + NONCE_BYTES + TAG_BYTES) throw new TypeError("provider session ciphertext is invalid");
  const bytes = Buffer.from(encrypted);
  if (!bytes.subarray(0, SESSION_VERSION.length).equals(SESSION_VERSION)) throw new TypeError("provider session ciphertext version is invalid");
  const nonceStart = SESSION_VERSION.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(nonceStart, tagStart));
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]);
    try { return deserializeCookieMaterial(plaintext.toString("utf8")); }
    finally { plaintext.fill(0); }
  } catch {
    throw new TypeError("provider session ciphertext authentication failed");
  }
}

function rowValue(row: ProviderSessionRow): StoredProviderSession {
  if (!(row.encrypted_cookie_material instanceof Uint8Array) || row.encrypted_cookie_material.byteLength === 0 || row.encrypted_cookie_material.byteLength > 64 * 1024) throw new TypeError("provider session row is corrupt");
  let expiresAt: string | null;
  if (row.expires_at === null || row.expires_at === undefined) expiresAt = null;
  else if (typeof row.expires_at === "string") { try { expiresAt = toInstant(row.expires_at).toString(); } catch { throw new TypeError("provider session row expiry is corrupt"); } }
  else throw new TypeError("provider session row expiry is corrupt");
  const storedAt = typeof row.updated_at === "string" ? (() => { try { return toInstant(row.updated_at).toString(); } catch { return null; } })() : null;
  if (storedAt === null) throw new TypeError("provider session row timestamp is corrupt");
  return {encryptedCookieMaterial: new Uint8Array(row.encrypted_cookie_material), expiresAt, storedAt};
}

/** Integration owner adapter; no provider body, credential, or plaintext cookie column exists. */
export class ProviderSessionStoreAdapter implements ProviderSessionStore {
  readonly #load: OwnerStatement<ProviderSessionRow, readonly SqlScalar[]>;
  readonly #save: OwnerStatement<Readonly<{scope_hash: unknown}>, readonly SqlScalar[]>;
  readonly #delete: OwnerStatement<Readonly<{scope_hash: unknown}>, readonly SqlScalar[]>;
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    this.#load = defineStatement(database, `SELECT encrypted_cookie_material, expires_at::text, updated_at::text
      FROM integration.provider_sessions WHERE scope_hash = $1 FOR UPDATE`);
    this.#save = defineStatement(database, `INSERT INTO integration.provider_sessions
      (scope_hash, encrypted_cookie_material, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3::timestamptz, clock_timestamp(), clock_timestamp())
      ON CONFLICT (scope_hash) DO UPDATE SET encrypted_cookie_material = EXCLUDED.encrypted_cookie_material,
        expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
      RETURNING scope_hash`);
    this.#delete = defineStatement(database, `DELETE FROM integration.provider_sessions WHERE scope_hash = $1 RETURNING scope_hash`);
  }

  load(scopeHash: string, signal?: AbortSignal): Promise<StoredProviderSession | undefined> {
    validScopeHash(scopeHash);
    return withTransaction(this.#database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, async transaction => {
      const result = await this.#load(transaction, [scopeHash]);
      const row = result.rows[0];
      return row === undefined ? undefined : rowValue(row);
    });
  }

  save(scopeHash: string, encryptedCookieMaterial: Uint8Array, expiresAt: string | null, signal?: AbortSignal): Promise<void> {
    validScopeHash(scopeHash);
    if (!(encryptedCookieMaterial instanceof Uint8Array) || encryptedCookieMaterial.byteLength === 0 || encryptedCookieMaterial.byteLength > 64 * 1024) throw new TypeError("provider session ciphertext is invalid");
    validExpiry(expiresAt);
    return withTransaction(this.#database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, async transaction => {
      await this.#save(transaction, [scopeHash, encryptedCookieMaterial, expiresAt]);
    });
  }

  delete(scopeHash: string, signal?: AbortSignal): Promise<void> {
    validScopeHash(scopeHash);
    return withTransaction(this.#database, {mode: "interactive", ...(signal === undefined ? {} : {signal})}, async transaction => {
      await this.#delete(transaction, [scopeHash]);
    });
  }
}

// Value export for composition roots that prefer the owner class name; the
// interface above remains the dependency-inversion port used by the Gateway.
export const ProviderSessionStore = ProviderSessionStoreAdapter;

/** Test seam with the same opaque-storage contract as the DB owner adapter. */
export class MemoryProviderSessionStore implements ProviderSessionStore {
  readonly #rows = new Map<string, StoredProviderSession>();
  public loadCalls = 0;
  public saveCalls = 0;
  public deleteCalls = 0;
  public lastSaved: StoredProviderSession | undefined;

  async load(scopeHash: string, signal?: AbortSignal): Promise<StoredProviderSession | undefined> {
    validScopeHash(scopeHash);
    signal?.throwIfAborted();
    this.loadCalls++;
    const row = this.#rows.get(scopeHash);
    return row === undefined ? undefined : {encryptedCookieMaterial: new Uint8Array(row.encryptedCookieMaterial), expiresAt: row.expiresAt, storedAt: row.storedAt};
  }

  async save(scopeHash: string, encryptedCookieMaterial: Uint8Array, expiresAt: string | null, signal?: AbortSignal): Promise<void> {
    validScopeHash(scopeHash);
    signal?.throwIfAborted();
    this.saveCalls++;
    const row = {encryptedCookieMaterial: new Uint8Array(encryptedCookieMaterial), expiresAt, storedAt: nowInstant().toString()};
    this.#rows.set(scopeHash, row);
    this.lastSaved = row;
  }

  async delete(scopeHash: string, signal?: AbortSignal): Promise<void> {
    validScopeHash(scopeHash);
    signal?.throwIfAborted();
    this.deleteCalls++;
    this.#rows.delete(scopeHash);
  }

  inspect(scopeHash: string): StoredProviderSession | undefined {
    validScopeHash(scopeHash);
    const row = this.#rows.get(scopeHash);
    return row === undefined ? undefined : {encryptedCookieMaterial: new Uint8Array(row.encryptedCookieMaterial), expiresAt: row.expiresAt, storedAt: row.storedAt};
  }
}
