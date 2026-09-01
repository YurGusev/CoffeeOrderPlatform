import "node:worker_threads";

type NodeTransferable = import("node:worker_threads").Transferable;

declare module "worker_threads" {
  /** Compatibility alias required by thread-stream 4.2.0 with @types/node 26. */
  export type TransferListItem = NodeTransferable;
}
