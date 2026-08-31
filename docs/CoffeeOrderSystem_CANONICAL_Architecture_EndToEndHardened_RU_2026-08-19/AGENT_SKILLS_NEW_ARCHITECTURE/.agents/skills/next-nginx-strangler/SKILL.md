---
name: next-nginx-strangler
description: "Use for public Nginx edge, route-family ownership, C#→TypeScript strangler routing, canary/rollback, TLS, coarse limits, and same-origin boundaries."
---

# Nginx Strangler Edge

## Source of truth

Каноническая программа: `M03_NGINX_STRANGLER`. Перед существенным изменением прочитать её `README.md` и релевантные нормативные документы. Если этот skill противоречит канонической программе, **побеждает каноническая программа**, а skill должен быть обновлён.

## Область действия

Этот skill относится **только к новой архитектуре CoffeeOrderSystem**. Нормативная зона записи:

```text
platform/**
edge/**          # только target/strangler изменения
infra/**         # новая Docker/Kafka/Debezium/Kubernetes topology
hermes/**
training/**
```

`src/**` является legacy/reference-зоной. Изменять `src/**` разрешено только когда задача явно требует characterization/parity instrumentation, migration adapter, rollback support или удаления legacy после принятого cutover. Нельзя использовать legacy C# архитектуру как шаблон для target-кода.

Новая platform не должна импортировать runtime-код, сборки или внутренние типы из `src/**`. Разрешены только language-neutral contracts, наблюдаемое поведение, database schema evidence и characterization tests.

## Use when

- меняется `edge/**`;
- переключается backend/frontend route family;
- нужен canary/rollback;
- меняются body/rate limits, proxy, SSE/WebSocket.

## Hard rules

- Nginx не содержит business logic.
- Public edge владеет TLS, routing, coarse rate/body limits, security headers и migration switch.
- Internal APIs не становятся публичными автоматически.
- Route limits задаются по semantics; избегать глобального oversized body limit.
- Canary/rollback должен менять routing, а не database truth.
- Нельзя переключать route на target до parity/release gate.
- SSE/WebSocket proxy settings отдельно от обычного API.

## Workflow

1. Определить route family и current/target upstream.
2. Добавить fail-closed target mapping.
3. Проверить headers/forwarding/body limits/timeouts.
4. Добавить canary и rollback control/evidence.
5. Запустить nginx -t и route smoke.
6. На cutover зафиксировать exact image digests/config hash и rollback path.

## Минимальная проверка

Перед завершением:

1. проверить соответствие каноническому документу программы;
2. проверить, что не создана новая скрытая cross-boundary зависимость;
3. выполнить targeted unit/integration/contract tests;
4. выполнить architecture/boundary tests для затронутого слоя;
5. проверить Docker build/health, если изменён runtime workload;
6. проверить observability и failure semantics, если изменён I/O/async path;
7. явно записать skipped checks и остаточный риск.


## M19 API Architecture

Public/private API allowlist определяется M19. Никогда не публиковать `agent-v1`/`internal-v1` через edge.
