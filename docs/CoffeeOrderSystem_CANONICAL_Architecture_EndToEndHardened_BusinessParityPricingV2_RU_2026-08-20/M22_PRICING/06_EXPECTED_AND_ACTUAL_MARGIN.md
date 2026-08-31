# Expected and actual margin

Expected:

```text
ExpectedRevenue = Σ Locked CustomerLineTotal
ExpectedCost = Σ QuotedLandedUnitCost * qty
ExpectedMargin = ExpectedRevenue - ExpectedCost
```

Actual:

```text
ActualSupplierCost = invoice-applied supplier cost
ActualDeliveryAllocation = proportional batch allocation (v1 default)
ActualCost = ActualSupplierCost + ActualDeliveryAllocation
ActualMargin = LockedCustomerRevenue - ActualCost
```

Delivery allocation v1 proportional to actual supplier goods subtotal. Allocation method/version stored, so future weight/volume methods do not rewrite history.

Margin projection is analytical; it never changes customer charge after Confirm.
