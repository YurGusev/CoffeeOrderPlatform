# Repair commands and audit

Work Center UI может инициировать только typed owner commands:

- reprice Draft;
- resolve Customer duplicate/link;
- request Catalog remap;
- trigger AROMA fresh reconciliation;
- save/manual invoice allocation;
- retry invoice price application;
- payment reconciliation/refund;
- review/activate delivery coefficient.

Каждый destructive/manual action требует actor, reason, expectedVersion и correlation id. Work Center никогда не делает direct cross-owner SQL update.
