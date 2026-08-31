# M19 — proof и exclusions

## Доказательная база

Registry собран на exact base `c54b225339156e451ba0811a7b66e2ed60b1f5f6` из:

- locked M19 canonical `README.md`, `13_OPENAPI_CANONICAL_ROUTES.md` и трёх canonical OpenAPI YAML;
- BusinessParity M19 contract documents для pricing, import/export/work-center и customer/invoice;
- current evidence snapshots `platform/evidence/contracts/openapi/{client-v1,agent-v1,internal-v1}.yaml`;
- accepted evidence overlay `platform/evidence/contracts/openapi/business-parity-overlay-routes.yml`.

Canonical OpenAPI даёт 26 операций: 15 `client-v1`, 6 `agent-v1`, 5 `internal-v1`. Evidence overlay добавляет 32 явно перечисленные операции: 30 `client-v1` и 2 `internal-v1`. Четыре approved M21 typed owner commands дополнительно представлены в M19 как machine-readable HTTP boundary: `repriceDraftOrder`, `requestCatalogRemap`, `requestOrderAromaReconciliation` и `refundPayment`. Поэтому closure содержит 62 операции: 49/6/7 по трём surface. Ни один route не извлекается из runtime, generated `obj`, контроллера или догадки по имени.

Для overlay-операций `operationId` стабильно выводится из уже доказанного manifest `id` (например, `pricing-product-projection` → `pricingProductProjection`). Это даёт machine-readable identity операции, но не утверждает наличие runtime implementation. Overlay success response сохраняется как OpenAPI `default`: status/schema остаются owner-defined, как указано в evidence. В registry это явно отмечено `source.kind = evidence-overlay` и `source.proof`.

## Нормативные safeguards

- Prefix проверяется как точный `/api/client-v1/`, `/api/agent-v1/` или `/api/internal-v1/`; `/client-v1/...`, `/agent-v1/...` и `/internal-v1/...` отвергаются.
- `(surface, method, path)`, route `id` и `operationId` уникальны.
- Mutation обязана иметь `staleVersionGuard.required = true`, конкретный guard type, `conflictStatus = 409`, а также обязательную idempotency key и unknown-outcome policy.
- У каждой операции есть owner, capability, actor/auth, success и ProblemDetails error policy, rollback и edge exposure.
- `agent-v1` и `internal-v1` всегда private; public edge разрешён только для `client-v1`.

## Явные exclusions

1. `/channels/vk/callback`, `/payments/webhooks/{provider}`, `/events`, Kafka topics и outbound provider APIs не включены в эти три OpenAPI surface: canonical M19 классифицирует их как отдельные webhook, realtime, event и provider transports, а в доступной route-level evidence нет полного machine-readable operation contract. Они не изобретаются в closure.
2. Registry не меняет existing canonical roots или `platform/evidence`; evidence-only overlays не превращаются в утверждение реализованного runtime.
3. Registry не добавляет DTO/request schemas, provider credentials, database ownership, deployment, Nginx configuration или runtime code. `ProblemDetails` и route-level policy — только contract authority.
4. Ошибки, guard и rollback policy не означают автоматическое выполнение retries или deployment. `UnknownOutcome` требует fresh read/reconciliation до повторной unsafe mutation.
5. М20/M06 event bindings и M21 Work Center command matrix остаются в ownership соответствующих workers; M19 фиксирует только HTTP boundary и ссылки на их evidence. Четыре перечисленные M21 owner routes добавлены по exact route/operationId matrix, а остальные M21 commands reconciled by their existing absolute M19 paths; дополнительные repair actions не изобретаются.
