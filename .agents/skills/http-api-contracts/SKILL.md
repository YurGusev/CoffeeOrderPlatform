---
name: http-api-contracts
description: Проектировать или реализовывать Effect HttpApi/OpenAPI, webhook, SSE, authentication, idempotency, concurrency и error-контракты CoffeeOrderPlatform для client, agent, internal и provider trust surfaces.
---

# Контракты HTTP API

Источник контрактов — Effect Schema и Effect HttpApi. Разделять
`/api/client-v1`, `/api/agent-v1`, `/api/internal-v1`, provider ingress и
`/events` по trust surface. В `#50` создавать только
`packages/contracts/common-v1` и `packages/contracts/runtime-v1`; `client-v1`,
`internal-v1` и `events-v1` создаёт `#4` вместе с первыми реальными contracts.
Пустые artifacts заранее не scaffolding-ить.

OpenAPI 3.1, JSON Schema 2020-12 и manifest генерируются детерминированно из
Effect source и являются проверяемыми артефактами, не runtime source of truth.
Production-код не импортирует generated JSON. Не добавлять Hey API, generated
SDK/client/hooks, параллельные DTO, Zod/AJV mirrors или handwritten transport
типы. Browser client строится из того же `client-v1` Effect contract.

Браузер и модели не выбирают actor identity, credentials, произвольные URL или
авторитетные денежные значения. Команды выражают намерение, требуют
`Idempotency-Key` и expected owner version; универсальный lifecycle PATCH
запрещён. Использовать RFC 9457 Problem Details со стабильными codes. Деньги и
64-битные версии передавать decimal strings.

Для каждого маршрута определить owner, actor, auth, schemas, deadline,
idempotency, concurrency, audit, exposure и side effects. Проверять
совместимость, запрет лишнего exposure, auth, дубликаты, старые версии, timeout
и response schemas.
