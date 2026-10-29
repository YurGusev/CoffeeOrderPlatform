import { withTransaction, type Database } from "@coffee-platform/database";
import type {
  CatalogAvailability,
  CatalogCursorPosition,
  CatalogPageStore,
  CatalogPricingInputRow,
  CatalogSearchRow,
} from "../../application/search-catalog.js";
import { CatalogRepository } from "./catalog-repository.js";

export type CatalogOwnerStore = CatalogPageStore &
  Readonly<{
    pricingInput: (
      productRef: string,
      variantRef: string,
      signal?: AbortSignal,
      correlationId?: string,
      maxSnapshotAgeMs?: number,
    ) => Promise<CatalogPricingInputRow | undefined>;
  }>;

export class CatalogStore implements CatalogOwnerStore {
  readonly #database: Database;
  readonly #repository: CatalogRepository;
  public constructor(database: Database) {
    this.#database = database;
    this.#repository = new CatalogRepository(database);
  }
  public async search(
    input: Readonly<{
      query: string;
      availability: CatalogAvailability | null;
      after: CatalogCursorPosition | null;
      limit: number;
      signal?: AbortSignal;
      correlationId?: string;
    }>,
  ): Promise<
    Readonly<{
      snapshotRevision: string | null;
      cursorValid: boolean;
      rows: readonly CatalogSearchRow[];
    }>
  > {
    const rows = await withTransaction(
      this.#database,
      {
        mode: "interactive",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.correlationId === undefined
          ? {}
          : { correlationId: input.correlationId }),
      },
      (transaction) => this.#repository.search(transaction, input),
    );
    return {
      snapshotRevision: rows[0]?.snapshotRevision ?? null,
      cursorValid: rows[0]?.cursorValid === true,
      rows: rows.filter((row) => row.productRef !== null),
    };
  }
  public async pricingInput(
    productRef: string,
    variantRef: string,
    signal?: AbortSignal,
    correlationId?: string,
    maxSnapshotAgeMs?: number,
  ): Promise<CatalogPricingInputRow | undefined> {
    return withTransaction(
      this.#database,
      {
        mode: "interactive",
        ...(signal === undefined ? {} : { signal }),
        ...(correlationId === undefined ? {} : { correlationId }),
      },
      (transaction) =>
        this.#repository.pricingInput(
          transaction,
          productRef,
          variantRef,
          maxSnapshotAgeMs,
        ),
    );
  }
}
