# ADR-0009: Domain-oriented selective microservices

**Status:** Accepted target

Не создавать network service per module/class. Сначала bounded modules + process roles. Физическая extraction происходит при независимом scaling/security/failure/release/persistence reason.
