# Pricing API contracts

## Internal quote

`POST /internal-v1/pricing/quotes`

Input: ProductVariantRef, quantity, pricingContext, requested/default markup, expected catalog/pricing projection when known.

Output uses decimal strings and includes every component + `quoteRef`, `pricingVersion`, `pricingHash`, `expiresAt`, `state`.

## Client/operator

```text
GET  /client-v1/pricing/products/{variantRef}
GET  /client-v1/pricing/delivery-coefficients/current
POST /client-v1/pricing/procurement-batches/{batchRef}/delivery-cost/preview
POST /client-v1/pricing/procurement-batches/{batchRef}/delivery-cost/activate
GET  /client-v1/pricing/procurement-batches/{batchRef}/margin
```

Mutation requires expectedVersion, reason and operator capability.

Orders Confirm endpoint never calls Pricing synchronously.
