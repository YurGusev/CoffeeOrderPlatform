# Customer/Search/Invoice recovery API contracts

Customer:

```text
GET  /client-v1/customers/search
POST /client-v1/customers/{ref}/merge
POST /client-v1/customers/{ref}/deactivate
POST /client-v1/customers/{ref}/anonymize
POST /client-v1/channel-customer-links/{ref}/confirm|reject|revoke|relink
```

Catalog Search:

```text
GET /client-v1/catalog/search
POST /internal-v1/catalog/resolve
```

Invoice recovery:

```text
POST /client-v1/invoices/intake
POST /client-v1/invoices/{ref}/validate
POST /client-v1/invoices/{ref}/commit-validation
GET  /client-v1/invoices/{ref}/allocation-preview
POST /client-v1/invoices/{ref}/allocations
POST /client-v1/invoices/{ref}/apply-prices
```

Все stale-sensitive commands принимают fingerprint/expectedVersion.
