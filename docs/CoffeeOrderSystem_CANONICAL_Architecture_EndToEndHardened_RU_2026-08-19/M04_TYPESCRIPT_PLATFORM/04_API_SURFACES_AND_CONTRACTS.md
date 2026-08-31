# M04. API surfaces и contract ownership — platform summary

## Статус

Полная нормативная API-архитектура вынесена в отдельную программу **M19_API_ARCHITECTURE**. Этот документ сохраняет только TypeScript-platform правила и ссылку на общий канон.

## Platform surfaces

```text
/api/client-v1   React/browser
/api/agent-v1    Hermes CoffeeOrder plugin
/api/internal-v1 private service-to-service/control plane
```

Webhook/callback, outbound provider, Kafka event и realtime API классифицируются и versioned в M19.

## Hard rules

- TypeScript HTTP adapters не смешивают actor/trust surfaces.
- `internal-v1` и `agent-v1` не публикуются public edge.
- Runtime validation обязательна на внешней границе.
- Business use cases не зависят от HTTP DTO.
- Contract artifacts language-neutral и живут в `platform/packages/contracts/`.
- React generation не зависит от `src/CoffeeOrderSystem.API/obj`.
- Hermes tools являются allowlisted capabilities, а не автоматическим зеркалом всей OpenAPI.
- Transaction-bound Kafka publication следует M06: local DB + Outbox + CDC.

## Canonical source

Читать `../M19_API_ARCHITECTURE/README.md` и документы M19 перед любым изменением API surface, webhook, provider integration, realtime contract или event API.
