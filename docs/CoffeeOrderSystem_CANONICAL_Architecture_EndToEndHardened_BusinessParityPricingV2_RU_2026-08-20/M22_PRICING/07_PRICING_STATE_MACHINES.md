# Pricing state machines

## Product price
`Unresolved → Current ↔ Stale`, `Current/Stale → Unavailable`, recovery back to Current.

## Order quote
`Missing → Current → Stale → Current`, then `Current → Locked`; Locked terminal for that manifest version.

## Delivery coefficient
`Draft → Calculated → Ready/ReviewRequired → Activated → Superseded`.

## Actual margin
`WaitingForInvoice → WaitingForDelivery → Complete`; correction creates new evidence version, never destructive overwrite.
