# M19 — API authority closure

Этот каталог фиксирует нормативную, language-neutral границу HTTP API для closure #1700. Источником registry является [`api-contract.json`](api-contract.json); JSON Schema находится в [`api-contract.schema.json`](api-contract.schema.json). OpenAPI-файлы в [`openapi/`](openapi/) и компактный [`api-route-contracts.json`](api-route-contracts.json) являются воспроизводимыми производными результатами. Последний сохранён для semantic verifier и не является второй authority.

Генерация и проверка:

```bash
python3 scripts/generate-architecture-closure-openapi.py --write
python3 scripts/generate-architecture-closure-openapi.py --check
python3 scripts/test-architecture-closure-openapi.py
```

Registry содержит только доказанные в текущем M19 canonical/evidence наборе операции:

| Surface | Actor/auth | Public edge | Операций |
|---|---|---:|---:|
| `/api/client-v1` | React/browser; user/session и CSRF для unsafe operations | да | 49 |
| `/api/agent-v1` | Hermes plugin; service identity и trusted conversation context | нет | 6 |
| `/api/internal-v1` | internal workload; per-workload service identity и explicit audience | нет | 7 |

Каждая операция содержит абсолютный `path`, `method`, стабильный `operationId`, owner/capability, actor/auth, read-vs-mutation, stale/version guard, idempotency, success/error response policy, rollback и public-edge classification. Ошибки используют общий `ProblemDetails` с `type`, `title`, `status`, `errorCode` и `traceId`.

Генератор fail-closed проверяет обязательный `/api/{surface}/` prefix, отсутствие suffix-only путей, уникальность `(surface, method, path)` и `operationId`, а также обязательный stale/version guard и idempotency policy для каждой mutation. См. [PROOF_AND_EXCLUSIONS.md](PROOF_AND_EXCLUSIONS.md) для provenance и явных границ.
