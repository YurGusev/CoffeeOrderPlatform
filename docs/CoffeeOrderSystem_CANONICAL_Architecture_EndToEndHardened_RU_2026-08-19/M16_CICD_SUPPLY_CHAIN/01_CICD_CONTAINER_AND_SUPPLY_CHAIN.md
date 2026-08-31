# 24. CI/CD, containers и supply chain

## 1. Один repository, два мира во время migration

CI graph разделяется:

```text
legacy-dotnet
platform-typescript
frontend
infra
contract-parity
integration-full
```

Изменение `platform/` не должно без причины перестраивать всю .NET solution, и наоборот.

## 2. Platform PR gates

Минимум:

```text
pnpm install --frozen-lockfile
typecheck
lint
format check
unit
architecture tests
contract tests
integration tests
Docker build
image smoke
```

Frontend дополнительно:

```text
CSP
bundle budget
Playwright
a11y
```

## 3. Docker build

Каждый deployable app создаёт immutable image. Использовать multi-stage builds и minimal runtime stage.

## 4. Image identity

Не использовать `latest` как release identity.

Фиксировать:

```text
registry/name:version
sha256 digest
source commit
build timestamp
lockfile hash
```

## 5. SBOM/security

CI генерирует/проверяет по возможности:

- dependency vulnerability scan;
- container scan;
- SBOM;
- secret scan;
- license policy.

## 6. Contract CI

Language-neutral OpenAPI/event schemas должны иметь:

- breaking change detector;
- generated artifacts freshness check;
- frontend client generation check;
- Kafka consumer compatibility tests.

## 7. DB migrations

Migration job отделён от application startup.

Нельзя запускать destructive migration автоматически на каждом pod start.

## 8. Promotion

```text
build once
 -> test digest
 -> stage digest
 -> canary same digest
 -> production same digest
```

Не пересобирать image между средами.

## 9. Full Compose test

CI периодически поднимает:

```text
edge
platform-web
legacy api
api-public + api-agent + api-internal
postgres
kafka/connect
provider stubs
Hermes stub/runtime
OTel
```

и выполняет end-to-end migration scenarios.

## 10. Kubernetes manifests

Helm/Kustomize/plain manifests выбираются отдельным ADR, но environment differences должны задаваться config/secrets, а не разными application images.


## 11. Node-specific baseline

Node production baseline, image/pnpm/native Kafka smoke, sync-API static rules, memory contract и upgrade policy определены в `02_NODEJS_CONTAINER_CICD_BASELINE.md`.

## Business service graph gate

CI должен парсить `M20_SERVICE_ORCHESTRATION/service-interaction-policy.yml` или эквивалентный кодовый manifest и проверять:

- forbidden cross-owner DB clients/imports;
- forbidden sync HTTP edges/cycles;
- AROMA Gateway image/service account не имеет Orders DB secret;
- Kafka producers/consumers соответствуют M06 Topic Registry и M20 owner matrix;
- target React/agent contracts не содержат `sendToAromaCart`;
- Orders Confirm codepath не имеет provider/Catalog/Invoices/Payments client dependency.
