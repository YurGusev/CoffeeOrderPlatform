import type {Pool, PoolClient} from "pg";
import type {DatabasePoolConfig} from "@coffee-platform/config";
import type {Database, Transaction, TransactionState, CorrelationMetadata} from "./index.js";

// Не экспортируется package entrypoints: драйвер доступен только DB foundation.
export type DatabaseData = {
  pool: Pool;
  config: DatabasePoolConfig;
  telemetryOwner: string;
  preferSsl: boolean;
  shutdown: AbortController;
  leases: Set<Lease>;
  pending: Set<Promise<unknown>>;
  healthy: boolean;
  saturated: number;
  acquiring: number;
  waiters: Waiter[];
  ending?: Promise<void>;
};
export type Lease = {client: PoolClient; released: boolean; broken: boolean; pending: number; onError: () => void};
export type Waiter = {resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void; shutdownAbort: () => void};
export type TransactionData = {
  database: Database;
  lease: Lease;
  state: TransactionState;
  signal: AbortSignal;
  metadata: CorrelationMetadata;
  pending: number;

};
export const databases: WeakMap<Database, DatabaseData> = new WeakMap();
export const transactions: WeakMap<Transaction, TransactionData> = new WeakMap();

export function track<T>(data: DatabaseData, promise: Promise<T>): Promise<T> {
  data.pending.add(promise);
  void promise.then(() => data.pending.delete(promise), () => data.pending.delete(promise));
  return promise;
}

export function trackLease<T>(data: DatabaseData, lease: Lease, promise: Promise<T>): Promise<T> {
  lease.pending++;
  return track(data, promise.finally(() => {lease.pending--;}));
}

export function bounded<T>(promise: Promise<T>, ms: number, failure: () => Error, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => finish(() => reject(failure()));
    const timer = setTimeout(abort, ms);
    const finish = (operation: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    void promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, {once: true});
  });
}
