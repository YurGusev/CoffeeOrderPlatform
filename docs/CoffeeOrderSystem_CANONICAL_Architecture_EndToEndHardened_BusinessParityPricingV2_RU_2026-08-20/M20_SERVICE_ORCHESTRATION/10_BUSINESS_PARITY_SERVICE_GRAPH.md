# Extended business-parity service graph

```text
AROMA Gateway → Catalog supplier sync → Catalog DB
                                   │
                         supplier price/discount facts
                                   ▼
                                Kafka
                                   ▼
                            Pricing Projection
                                   │
                                   ▼
                              Pricing DB
                                   │
                     quotes / product price projections
                          ┌────────┴────────┐
                          ▼                 ▼
                       Orders          Work Center

React → api-public → Orders / Customer / Pricing / Work Center / Invoices
Hermes → api-agent → Customer/Catalog/Orders tools

Orders → AROMA convergence → AROMA Gateway
Orders → Checkout manifest → Invoices
Invoices → actual supplier cost → Pricing
Orders → payment requirement → Payments
Payments → verified result → Orders
```

Import/Export and media heavy work execute out-of-process workers.
