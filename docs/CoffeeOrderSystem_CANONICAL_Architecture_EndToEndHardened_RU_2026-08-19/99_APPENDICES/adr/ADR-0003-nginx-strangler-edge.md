# ADR-0003: Nginx является public edge и Strangler switch

**Status:** Accepted target

`coffee-edge` остаётся единственным public application entrypoint и переключает web/API route families между old/new workloads. DB ownership совместимость является обязательным условием route rollback.
