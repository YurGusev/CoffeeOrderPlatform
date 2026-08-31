# Pricing acceptance tests

Minimum characterization/target cases:

1. Base 30, no special → 30.
2. Base 30, special 10 → 10.
3. Base 30, special 35 → 35.
4. No stacking.
5. Conditional special below threshold → base.
6. Conditional special at threshold → special.
7. Delivery 1.3 exact formula/rounding.
8. Markup each 5..10 accepted; 4/11 rejected; 0 only authorized exception.
9. Draft stale after supplier price/discount/coefficient change.
10. Confirm rejects stale quote without Pricing HTTP.
11. Confirm locks final customer price.
12. Invoice actual supplier price changes actual cost but not locked customer price.
13. Actual delivery computes next coefficient and does not rewrite old orders.
14. New ProductPriceProjection after coefficient activation.
15. Expected/actual margin reproducible from immutable evidence.
