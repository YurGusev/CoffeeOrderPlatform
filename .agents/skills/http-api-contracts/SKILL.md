---
name: http-api-contracts
description: Проектировать или реализовывать REST/OpenAPI, webhook, SSE, authentication, idempotency, concurrency и error-контракты CoffeeOrderPlatform для client, agent, internal и provider trust surfaces.
---

# Контракты HTTP API

Использовать OpenAPI 3.2 и runtime JSON Schema. Разделять `/api/client-v1`,
`/api/agent-v1`, `/api/internal-v1`, provider ingress, and `/events` trust
модели доверия.

Браузер и модели не выбирают actor identity, credentials, произвольные URL или
авторитетные денежные значения. Команды выражают намерение, требуют
`Idempotency-Key` и expected owner version; универсальный lifecycle PATCH
запрещён. Использовать RFC 9457 Problem Details со стабильными codes. Деньги и
64-битные версии передавать decimal strings.

Для каждого маршрута определить owner, actor, auth, schemas, deadline,
idempotency, concurrency, audit, exposure и side effects. Проверять
совместимость, запрет лишнего exposure, auth, дубликаты, старые версии, timeout
и response schemas.
