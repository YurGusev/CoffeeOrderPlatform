# ADR-0007: Один domain schema — один production writer

**Status:** Accepted target

Во время C#→TS migration запрещено одновременно разрешать legacy и target mutation paths к одной domain schema. Ownership переключается только через DB5 gate и expand/contract-compatible migration window.
