import {ProviderError} from "../../domain/provider-errors.js";
import {nowInstant, toInstant} from "@coffee-platform/platform-time";

function epochMilliseconds(value: string): number {
  try { return Number(toInstant(value).epochMilliseconds); } catch { return Number.NaN; }
}
import {earliestCookieExpiry, type ProviderCookie} from "./cookie-jar.js";
import type {MutationOperation, ProviderLoginResult, ProviderMutationTransportResult, ReadOperation} from "./http-client.js";
import {
  decryptCookieMaterial,
  encryptCookieMaterial,
  providerSessionScopeHash,
  type ProviderSessionStore,
} from "../database/provider-session-store.js";

/**
 * BOUNDED_LOCAL_SESSION_CACHE: local decrypted-cookie cache only. It is not a
 * provider TTL or refresh contract. Explicit cookie expiry always wins; when
 * no expiry is supplied, this local age bound is the only reuse policy.
 */
export const BOUNDED_LOCAL_SESSION_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
export const BOUNDED_LOCAL_SESSION_CACHE_MAX_ENTRIES = 32;

export type ProviderCredentialScope = Readonly<{
  /** Caller-selected environment/integration scope; never persisted verbatim. */
  scopeRef: string;
  email: string;
  password: string;
}>;

export type ProviderSession = Readonly<{
  scopeHash: string;
  expiresAt: string | null;
  /** Internal Gateway handoff; raw cookie material remains private to the manager. */
  read: (operation: ReadOperation, signal: AbortSignal) => AsyncGenerator<Uint8Array>;
  mutate: (operation: MutationOperation, signal: AbortSignal) => Promise<ProviderMutationTransportResult>;
}>;

export interface ProviderLoginTransport {
  login(credentials: Readonly<{email: string; password: string}>, signal: AbortSignal): Promise<ProviderLoginResult>;
  read?: (operation: ReadOperation, signal: AbortSignal, cookies?: readonly ProviderCookie[]) => AsyncGenerator<Uint8Array, readonly ProviderCookie[]>;
  mutate?: (operation: MutationOperation, signal: AbortSignal, cookies?: readonly ProviderCookie[]) => Promise<ProviderMutationTransportResult>;
  close?(): Promise<void>;
}

type CachedSession = Readonly<{session: ProviderSession; cookies: readonly ProviderCookie[]; cachedAt: number; state: SessionState}>;
type SessionState = {active: boolean; generation: number; cookies: ProviderCookie[]};
type ScopeState = {
  generation: number;
  currentState: SessionState | undefined;
  persistence: Promise<void>;
};
type Flight = Readonly<{
  controller: AbortController;
  promise: Promise<ProviderSession>;
  email: string;
  password: string;
  waiters: {count: number};
}>;

function credentials(value: ProviderCredentialScope): Readonly<{scopeRef: string; email: string; password: string}> {
  if (value === null || typeof value !== "object" ||
    typeof value.scopeRef !== "string" || value.scopeRef.length === 0 || value.scopeRef.length > 128 || !value.scopeRef.isWellFormed() || value.scopeRef.includes("\u0000") ||
    typeof value.email !== "string" || value.email.length === 0 || !value.email.isWellFormed() ||
    typeof value.password !== "string" || value.password.length === 0 || !value.password.isWellFormed()) {
    throw new ProviderError("ProviderProtocolViolation");
  }
  const email = value.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ProviderError("ProviderProtocolViolation");
  return {scopeRef: value.scopeRef, email, password: value.password};
}

function usableExpiry(expiresAt: string | null, now: number): boolean {
  return expiresAt === null || epochMilliseconds(expiresAt) > now;
}

function usableCookies(cookies: readonly ProviderCookie[], now: number): boolean {
  return cookies.some(cookie => cookie.value.length > 0 && (cookie.expiresAt === null || epochMilliseconds(cookie.expiresAt) > now));
}

function mergeCookies(current: readonly ProviderCookie[], updates: readonly ProviderCookie[], now: number): readonly ProviderCookie[] {
  const merged = new Map(current.map(cookie => [`${cookie.name}\u0000${cookie.domain ?? ""}\u0000${cookie.path}`, cookie]));
  for (const cookie of updates) {
    const key = `${cookie.name}\u0000${cookie.domain ?? ""}\u0000${cookie.path}`;
    if (cookie.value.length === 0 || (cookie.expiresAt !== null && epochMilliseconds(cookie.expiresAt) <= now)) merged.delete(key);
    else merged.set(key, cookie);
  }
  return [...merged.values()];
}

/** Gateway owner for login, encrypted persistence, cache bounds, and cleanup. */
export class ProviderSessionManager {
  readonly #transport: ProviderLoginTransport;
  readonly #store: ProviderSessionStore;
  readonly #encryptionKey: Uint8Array;
  readonly #cache = new Map<string, CachedSession>();
  readonly #sessionStates = new Set<SessionState>();
  readonly #scopeStates = new Map<string, ScopeState>();
  readonly #flights = new Map<string, Flight>();
  readonly #activeReads = new Set<Promise<void>>();
  readonly #lifecycle = new AbortController();
  readonly #now: () => number;
  readonly #cacheMaxAgeMs: number;
  readonly #cacheMaxEntries: number;
  #closed = false;
  #shutdownEpoch = 0;
  #forceDestroyed = false;
  #closePromise: Promise<void> | undefined;
  #transportClosePromise: Promise<void> | undefined;

  constructor(options: Readonly<{
    transport: ProviderLoginTransport;
    store: ProviderSessionStore;
    encryptionKey: Uint8Array;
    now?: () => number;
    cacheMaxAgeMs?: number;
    cacheMaxEntries?: number;
  }>) {
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32 ||
      !Number.isSafeInteger(options.cacheMaxAgeMs ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_AGE_MS) || (options.cacheMaxAgeMs ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_AGE_MS) <= 0 ||
      !Number.isSafeInteger(options.cacheMaxEntries ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_ENTRIES) || (options.cacheMaxEntries ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_ENTRIES) <= 0) {
      throw new ProviderError("ProviderProtocolViolation");
    }
    this.#transport = options.transport;
    this.#store = options.store;
    this.#encryptionKey = new Uint8Array(options.encryptionKey);
    this.#now = options.now ?? (() => Number(nowInstant().epochMilliseconds));
    this.#cacheMaxAgeMs = options.cacheMaxAgeMs ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_AGE_MS;
    this.#cacheMaxEntries = options.cacheMaxEntries ?? BOUNDED_LOCAL_SESSION_CACHE_MAX_ENTRIES;
  }

  #scopeState(scopeHash: string): ScopeState {
    let state = this.#scopeStates.get(scopeHash);
    if (state === undefined) {
      state = {generation: 0, currentState: undefined, persistence: Promise.resolve()};
      this.#scopeStates.set(scopeHash, state);
    }
    return state;
  }

  #isOpen(epoch = this.#shutdownEpoch): boolean {
    return !this.#closed && epoch === this.#shutdownEpoch;
  }

  /** Serialize only short persistence operations; provider HTTP stays outside this queue. */
  #persist<T>(scopeHash: string, operation: () => Promise<T>): Promise<T> {
    const scope = this.#scopeState(scopeHash);
    const run = scope.persistence.then(operation, operation);
    scope.persistence = run.then(() => undefined, () => undefined);
    return run;
  }

  #isCurrent(scopeHash: string, state: SessionState): boolean {
    const scope = this.#scopeState(scopeHash);
    return state.active && scope.generation === state.generation && scope.currentState === state;
  }

  #retire(scopeHash: string, state: SessionState): void {
    const scope = this.#scopeState(scopeHash);
    state.active = false;
    state.cookies.splice(0);
    this.#sessionStates.delete(state);
    if (scope.currentState !== state || scope.generation !== state.generation) return;
    scope.generation += 1;
    scope.currentState = undefined;
  }

  acquire(scope: ProviderCredentialScope, signal: AbortSignal = new AbortController().signal): Promise<ProviderSession> {
    if (this.#closed) return Promise.reject(new ProviderError("ProviderSessionUnavailable"));
    const checked = credentials(scope);
    signal.throwIfAborted();
    const scopeHash = providerSessionScopeHash(checked.scopeRef, checked.email);
    const cached = this.#cache.get(scopeHash);
    const now = this.#now();
    if (cached !== undefined && this.#isCurrent(scopeHash, cached.state) && now - cached.cachedAt >= 0 && now - cached.cachedAt <= this.#cacheMaxAgeMs && usableExpiry(cached.session.expiresAt, now) && usableCookies(cached.cookies, now)) {
      this.#cache.delete(scopeHash);
      this.#cache.set(scopeHash, cached);
      return Promise.resolve(cached.session);
    }
    if (cached !== undefined) {
      this.#retire(scopeHash, cached.state);
    }
    this.#cache.delete(scopeHash);
    let flight = this.#flights.get(scopeHash);
    if (flight?.controller.signal.aborted === true) {
      if (this.#flights.get(scopeHash) === flight) this.#flights.delete(scopeHash);
      flight = undefined;
    }
    if (flight !== undefined && (flight.email !== checked.email || flight.password !== checked.password)) {
      return Promise.reject(new ProviderError("ProviderProtocolViolation"));
    }
    if (flight === undefined) {
      const controller = new AbortController();
      const waiters = {count: 0};
      const promise = this.#loadOrLogin(checked, scopeHash, controller.signal).finally(() => {
        if (this.#flights.get(scopeHash)?.promise === promise) this.#flights.delete(scopeHash);
      });
      flight = {controller, promise, email: checked.email, password: checked.password, waiters};
      this.#flights.set(scopeHash, flight);
    }
    return this.#waitFor(flight, signal);
  }

  async #waitFor(flight: Flight, signal: AbortSignal): Promise<ProviderSession> {
    flight.waiters.count++;
    return new Promise<ProviderSession>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        flight.waiters.count--;
        if (flight.waiters.count === 0) flight.controller.abort();
        reject(new ProviderError("ProviderCancelled"));
      };
      signal.addEventListener("abort", abort, {once: true});
      flight.promise.then(value => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        flight.waiters.count--;
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        flight.waiters.count--;
        reject(error instanceof ProviderError ? error : new ProviderError("ProviderSessionUnavailable"));
      });
    });
  }

  async #loadOrLogin(scope: Readonly<{scopeRef: string; email: string; password: string}>, scopeHash: string, signal: AbortSignal): Promise<ProviderSession> {
    const shutdownEpoch = this.#shutdownEpoch;
    const now = this.#now();
    const scopeState = this.#scopeState(scopeHash);
    const generation = scopeState.generation;
    let stored;
    try { stored = await this.#persist(scopeHash, () => this.#store.load(scopeHash, signal)); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("ProviderSessionUnavailable");
    }
    if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
    const storedAge = stored === undefined ? Number.POSITIVE_INFINITY : now - epochMilliseconds(stored.storedAt);
    if (this.#isOpen(shutdownEpoch) && scopeState.generation === generation && stored !== undefined && Number.isFinite(storedAge) && storedAge >= 0 && storedAge <= this.#cacheMaxAgeMs && usableExpiry(stored.expiresAt, now)) {
      try {
        const cookies = decryptCookieMaterial(stored.encryptedCookieMaterial, this.#encryptionKey);
        if (usableCookies(cookies, now)) {
          if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
          return this.#remember(scopeHash, cookies, stored.expiresAt);
        }
      } catch {
        // Corrupt/authentication-failed ciphertext is discarded, never exposed.
      }
      if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
      await this.#persist(scopeHash, () => this.#store.delete(scopeHash, signal));
    }
    if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
    signal.throwIfAborted();
    let login: ProviderLoginResult;
    try { login = await this.#transport.login({email: scope.email, password: scope.password}, signal); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("ProviderAuthenticationFailed");
    }
    if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
    if (login.profile.email.trim().toLowerCase() !== scope.email) throw new ProviderError("ProviderProtocolViolation");
    const activeCookies = login.cookies.filter(cookie => cookie.expiresAt === null || epochMilliseconds(cookie.expiresAt) > this.#now());
    if (!usableCookies(activeCookies, this.#now())) throw new ProviderError("ProviderSessionUnavailable");
    const expiresAt = earliestCookieExpiry(activeCookies);
    const encrypted = encryptCookieMaterial(activeCookies, this.#encryptionKey);
    let persisted = false;
    try {
      await this.#persist(scopeHash, async () => {
        if (!this.#isOpen(shutdownEpoch) || scopeState.generation !== generation || scopeState.currentState !== undefined) return;
        await this.#store.save(scopeHash, encrypted, expiresAt, signal);
        if (!this.#isOpen(shutdownEpoch)) return;
        persisted = true;
      });
    }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("ProviderSessionUnavailable");
    }
    if (!persisted) {
      if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
      const current = this.#cache.get(scopeHash);
      if (current !== undefined && this.#isCurrent(scopeHash, current.state)) return current.session;
      throw new ProviderError("ProviderSessionUnavailable");
    }
    if (!this.#isOpen(shutdownEpoch)) throw new ProviderError("ProviderSessionUnavailable");
    return this.#remember(scopeHash, activeCookies, expiresAt);
  }

  #remember(scopeHash: string, cookies: readonly ProviderCookie[], expiresAt: string | null): ProviderSession {
    if (!this.#isOpen()) throw new ProviderError("ProviderSessionUnavailable");
    // The manager is constructed inside the Gateway with the trusted provider
    // transport. An empty host here means "the already validated provider
    // cookie set", never an arbitrary caller-selected host.
    const scope = this.#scopeState(scopeHash);
    const previous = this.#cache.get(scopeHash);
    if (previous !== undefined) this.#retire(scopeHash, previous.state);
    const state: SessionState = {active: true, generation: scope.generation + 1, cookies: [...cookies]};
    scope.generation = state.generation;
    scope.currentState = state;
    this.#sessionStates.add(state);
    const session: ProviderSession = Object.freeze({
      scopeHash,
      expiresAt,
      read: (operation, signal) => this.#readSession(scopeHash, state, operation, signal),
      mutate: (operation, signal) => this.#mutateSession(state, operation, signal),
    });
    this.#cache.set(scopeHash, {session, cookies: [...cookies], cachedAt: this.#now(), state});
    while (this.#cache.size > this.#cacheMaxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (typeof oldest !== "string") break;
      const evicted = this.#cache.get(oldest);
      if (evicted !== undefined) {
        this.#retire(oldest, evicted.state);
      }
      this.#cache.delete(oldest);
    }
    return session;
  }

  async *#readSession(scopeHash: string, state: SessionState, operation: ReadOperation, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!state.active || this.#transport.read === undefined) throw new ProviderError("ProviderSessionUnavailable");
    const combinedSignal = AbortSignal.any([signal, this.#lifecycle.signal]);
    let finishRead!: () => void;
    const activeRead = new Promise<void>(resolve => { finishRead = resolve; });
    this.#activeReads.add(activeRead);
    let source: AsyncGenerator<Uint8Array, readonly ProviderCookie[]> | undefined;
    try {
      source = this.#transport.read(operation, combinedSignal, state.cookies);
      while (true) {
        const chunk = await source.next();
        if (chunk.done) {
          if (chunk.value.length > 0) await this.#rotate(scopeHash, state, chunk.value);
          return;
        }
        yield chunk.value;
      }
    } catch (error) {
      if (error instanceof ProviderError && error.code === "ProviderAuthenticationFailed") await this.#invalidate(scopeHash, state);
      throw error;
    } finally {
      try { await source?.return([]); } catch { /* preserve the provider result */ }
      finishRead();
      this.#activeReads.delete(activeRead);
    }
  }

  async #mutateSession(state: SessionState, operation: MutationOperation, signal: AbortSignal): Promise<ProviderMutationTransportResult> {
    if (!state.active || this.#transport.mutate === undefined) throw new ProviderError("ProviderSessionUnavailable");
    signal.throwIfAborted();
    try { return await this.#transport.mutate(operation, signal, state.cookies); }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("ProviderUnavailable"); }
  }

  async #rotate(scopeHash: string, state: SessionState, updates: readonly ProviderCookie[]): Promise<void> {
    const shutdownEpoch = this.#shutdownEpoch;
    let invalid = false;
    await this.#persist(scopeHash, async () => {
      const cached = this.#cache.get(scopeHash);
      if (!this.#isOpen(shutdownEpoch) || !this.#isCurrent(scopeHash, state) || cached === undefined || cached.state !== state) return;
      const now = this.#now();
      const merged = mergeCookies(state.cookies, updates, now);
      if (!usableCookies(merged, now)) { invalid = true; return; }
      const expiresAt = earliestCookieExpiry(merged);
      await this.#store.save(scopeHash, encryptCookieMaterial(merged, this.#encryptionKey), expiresAt, AbortSignal.timeout(this.#cacheMaxAgeMs));
      if (!this.#isOpen(shutdownEpoch) || !this.#isCurrent(scopeHash, state)) return;
      state.cookies.splice(0, state.cookies.length, ...merged);
      this.#cache.set(scopeHash, {...cached, cookies: [...merged], cachedAt: now});
    });
    if (invalid) {
      await this.#invalidate(scopeHash, state);
      throw new ProviderError("ProviderSessionUnavailable");
    }
    if (!this.#isOpen(shutdownEpoch) || !this.#isCurrent(scopeHash, state)) throw new ProviderError("ProviderSessionUnavailable");
  }

  async #invalidate(scopeHash: string, state: SessionState): Promise<void> {
    const current = this.#isCurrent(scopeHash, state);
    const scope = this.#scopeState(scopeHash);
    this.#retire(scopeHash, state);
    if (this.#cache.get(scopeHash)?.state === state) this.#cache.delete(scopeHash);
    if (!current) return;
    const invalidatedGeneration = scope.generation;
    await this.#persist(scopeHash, async () => {
      if (scope.generation !== invalidatedGeneration || scope.currentState !== undefined) return;
      await this.#store.delete(scopeHash, AbortSignal.timeout(this.#cacheMaxAgeMs));
    });
  }

  #beginShutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdownEpoch += 1;
    this.#lifecycle.abort();
    this.#cache.clear();
    for (const state of this.#sessionStates) {
      state.active = false;
      state.cookies.splice(0);
    }
    this.#sessionStates.clear();
    for (const flight of this.#flights.values()) flight.controller.abort();
  }

  #closeTransport(): Promise<void> {
    this.#transportClosePromise ??= Promise.resolve().then(() => this.#transport.close?.()).then(() => undefined);
    return this.#transportClosePromise;
  }

  async #closeImpl(): Promise<void> {
    this.#beginShutdown();
    await Promise.allSettled([...this.#flights.values()].map(flight => flight.promise));
    this.#flights.clear();
    await Promise.allSettled(this.#activeReads);
    await Promise.allSettled(Array.from(this.#scopeStates.values(), scope => scope.persistence));
    await this.#closeTransport();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeImpl();
    return this.#closePromise;
  }

  /**
   * Fail-stop shutdown for a runtime deadline. It deliberately does not wait
   * for provider generators that ignore cancellation; the transport is still
   * closed exactly once and normal close keeps its shared promise.
   */
  forceDestroy(): void {
    if (this.#forceDestroyed) return;
    this.#forceDestroyed = true;
    this.#beginShutdown();
    void this.#closeTransport().catch(() => { /* fail-stop cleanup is best effort */ });
  }
}
