# M11 — AROMA Provider Boundary + Authoritative Cart Safety

## Цель

Перенести AROMA в новую архитектуру без потери уже реализованных consistency-инвариантов.

**Ключевое решение:** target не переносит legacy `AromaCartFillBatch`/`sendToAromaCart`. Единственный normal path — `Confirm -> Desired -> Observed -> Convergence`.

## Ownership

- AROMA Gateway: provider protocol/auth/session/HTTP only.
- Orders: Desired/Observed/Convergence/Attempt/Lease/Fencing/UnknownOutcome/Checkout/Fulfillment.
- Catalog: mapping/availability facts.

## Документы

1. `01_AROMA_MIGRATION_AND_SAFETY.md` — migration strategy.
2. `02_AROMA_GATEWAY_PROVIDER_CONTRACT.md` — provider boundary.
3. `03_AUTHORITATIVE_CART_DESIRED_OBSERVED_CONVERGENCE.md` — critical state machine.
4. `04_AROMA_CHECKOUT_WHOLESALE_CONTRACT.md` — checkout/wholesale proof.
5. `05_LEGACY_CART_FILL_RETIREMENT.md` — что не переносить.

Service graph — M20.

- `06_CATALOG_DRIVEN_CART_SAFETY.md` — Catalog Product/availability/mapping facts → Orders Desired → safe cart convergence.

- `07_MUTATION_RESERVATION_AND_FENCING.md`

- `08_CHECKOUT_CANCEL_RACE_AND_COMPENSATION.md`
