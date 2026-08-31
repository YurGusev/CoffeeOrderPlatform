# Order price lock and stale rules

PricingQuote immutable and short-lived/version-bound. Quote contains all components, not just final number.

```text
Draft item
→ Quoted(Current)
→ Stale when dependent pricing fact/version changes
→ Requoted
→ Locked by Orders Confirm
```

Confirm transaction uses no external HTTP. Orders consumes Pricing lifecycle into local projection and rejects stale quote/hash.

After Locked:

- Catalog price change: no customer-price rewrite;
- special discount change: no customer-price rewrite;
- delivery coefficient change: no customer-price rewrite;
- supplier PDF actual cost: no customer-price rewrite.

Only explicit pre-freeze confirmed-order mutation can create a new price-manifest version for changed lines.
