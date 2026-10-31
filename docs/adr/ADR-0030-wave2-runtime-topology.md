# ADR-0030: отдельная физическая топология второй волны

Позднее [ADR-0031](ADR-0031-nginx-transport-and-application-auth.md) уточняет
только public transport launch base для W2 после #162: private application
`edge-gateway` и native `edge-nginx` вместо прежнего Node proxy/`web` runtime.
Target роли W2, их DB/owners/provider contracts и исторический #71 handoff
не меняются; точный PSP ingress остаётся за #76/#77.

- Статус: target-решение #71; становится принятым после merge PR в `develop`; **не runtime admission**.
- Дата: 2026-09-24. Владелец: Platform Architecture.
- Вход: #66 / PR #67, merge `6934221dc1162af706d73e9d3c230bd51c3e4243`, `evidence/handoffs/issue-66.yaml`.
- Нормативная проекция решения: [02_RUNTIME_TOPOLOGY.md](../wave-2/02_RUNTIME_TOPOLOGY.md). Числовые target budgets задаются только там; исполнимые значения после materialization — только `config/platform.yaml`.

## Контекст и момент переключения

Позднее [ADR-0032](ADR-0032-order-reconciliation-intent.md) расширил launch
registry до восьми сообщений; ниже exact-seven — исторический snapshot #71,
не актуальный prerequisite #76. [ADR-0033](ADR-0033-wave2-header-revenue-boundaries.md)
уточняет target header/financial phases одной orders-invoice-consumer роли и
минимальные revenue grants, не увеличивая fleet. Исторический handoff не
переписывается; документальная поставка ADR-0033 ожидает merge, не runtime admission.

[ADR-0019](ADR-0019-greenfield-node26-and-service-topology.md), [ADR-0025](ADR-0025-fastify-launch-recovery.md) и launch-каталоги фиксируют **ровно 15 runtime / 5 owner DB** первой волны. #66 описал будущие Invoice/Payment/Checkout, но не расширил действующую конфигурацию. Даже закрытый #71 не разрешает W2 deployment. До принятого launch #13 с #64 остаются прежние topology, exact-seven message inventory #4, order-only SSE #12, роли/ACL и launch evidence. Никакой статус #13 не предполагается заранее.

После принятого #13 contracts #76 расширяют **тот же** источник schemas/messages/types-only генерации, фиксируют Kafka topic/group/ACL и operation allowlist; не создают второй реестр или условный launch/W2 codegen. Core materialization #77 изменяет config/DB migrations/Compose/permissions только по принятому handoff #76, затем #120 расширяет существующий realtime transport до invoice/Work Center subjects, а #121 подключает новые roots к #64 Collector/OpenObserve и alert gates. Они не являются prerequisites #77; полное W2 admission требует #90. Исторические #4/#12/#13 handoffs не переписываются. ADR supersede-ит только запрет **будущего W2-расширения** exact-15/exact-5, exact-seven и order-only subjects после указанных gates; не отменяет их как условия launch acceptance.

## Владельцы и физические роли

[Матрица](../wave-2/02_RUNTIME_TOPOLOGY.md#роли-процессы-и-сети) назначает каждой роли executable, owner, DB principal, сети, допуск и health. Один container — одна роль; runtime первого запуска переиспользуются без переименования. Orders владеет checkout/freeze, exact link, lifecycle/compensation, таймерами wholesale/header и document delivery. `aroma-gateway` остаётся **единственным** держателем AROMA session/credential и provider transport/journal; он не принимает бизнес-решение о связи с Order или invoice. Invoices владеет header/allocations/proofs в своей DB. Payments владеет intent/verified webhook/reconciliation/refund evidence в своей DB; Orders решает lifecycle. Pricing владеет cost/margin/coefficient, Work Center — только собственной projection и operator read/command forwarding, не чужой business state. Обособление обусловлено разными trust, credential, I/O, отказами и масштабированием, а не требованием отдельной БД на каждый процесс.

Новые owner DB: `coffee_platform_invoices`, `coffee_platform_payments`, `coffee_platform_work_center`; единственный writer миграций — соответственно Invoices, Payments, Work Center. Отдельная инфраструктурная `coffee_platform_artifacts` хранит только refs/scan jobs/verdict, и только Artifact Operations мигрирует её schema. У каждой роли grant на свои tables/functions, shared SQL ownership и direct joins между owners отсутствуют. Inbox, бизнес-запись и Outbox — одна локальная транзакция; network I/O и storage/scan не выполняются под DB lock. Kafka at-least-once и durable owner state, не browser/offset, определяют восстановление. Общий business orchestrator, Redis и Kubernetes не добавляются.

Private immutable object storage — **инфраструктура**, не бизнес-владелец. `artifact-metadata-service` выдаёт authorized opaque ArtifactRef и сохраняет metadata; external PDF сначала quarantine, `artifact-scan-worker` выдаёт verdict по тому же hash, только Ready допускает parsing и выдачу. `orders-document-worker` после safe Gateway GET через authenticated `api-internal` пишет quarantined bytes вне Orders transaction, ждёт Ready verdict и лишь затем атомарно сохраняет delivery revision и Outbox для Invoices. `invoice-document-worker` проверяет bytes/hash/schema и пишет Invoices proof; ни Gateway, ни scanner не пишут Orders/Invoices DB. Trusted generated JSON manifests требуют hash/schema validation, но не PDF scanner. Retention/restore и scoped read grants зафиксированы в матрице; filename/URL/provider response не являются полномочием.

## Trust, конфигурация и последствия

`edge-gateway` — единственный browser ingress и trusted actor; `api-public` и `api-internal` выполняют typed forwarding/delegation, но не имеют DB, Kafka, AROMA/PSP creds. Provider webhook входит только через отдельный allowlisted edge route к Payments webhook с обязательной проверкой подписи/replay. AROMA egress — только Gateway к exact origin, PSP egress — только выделенные Payments workers. Private service mTLS, scoped network ACL, default-deny egress и Node Permission Model дополняют Docker network; общая сеть не является разрешением на произвольный порт. Secrets — только SOPS через trusted `config-bootstrap` в scoped tmpfs; браузер/Orders/Invoices не получают AROMA credential, а browser не задаёт actor, authoritative money или PSP proof.

Scoped network ACL и default-deny egress здесь — требования будущей Wave 2,
а не доказанная per-host TCP гарантия локального запуска; см. [ADR-0041](ADR-0041-local-server-network-boundaries.md).

Fastify + `pg` + Kafka + types-only OpenAPI/JSON Schema остаются одной технической линией. [Канонические revision roots](../CoffeeOrderSystem_CANONICAL_Architecture_ContractClosure_RU_2026-08-22/README.md) не изменяются: historical M20 role registry — reference для роли, но его `platform/apps/**`, DB principal и старый realtime group не копируются как исполнимая greenfield authority. Новые W2-only роли названы явно в матрице. #76 отвечает за контракты/permissions bindings; #77 — за config/schema/Compose/migrations/runtime; #78 — за immutable storage, #122 — за external scan, #123 — за Orders PDF handoff; #120/#121 — за transport/telemetry, #90 — за числовой gate. Этот ADR не создаёт runtime, БД, секреты, pins или provider mutations.
