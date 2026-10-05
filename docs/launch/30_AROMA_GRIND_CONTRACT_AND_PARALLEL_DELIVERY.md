# Контракт помола и границы параллельной разработки #9 / #11

Статус: утверждено архитектором 28 сентября 2026 по прямому поручению владельца
подготовить #11 и передать реализацию разработчику. Это решение для реализации,
не свидетельство готовности кода или production. Исходная принятая ревизия:
`e278aeb10e57d37485542f8668f078456074b038` (`develop`, PR #170).
Документ и изменения поведения поставляются в одной ветке/PR #11.

## 1. Результат и приоритет

#11 сохраняет результат: Orders-owned Desired/Observed, observer, fenced
convergence и восстановление UnknownOutcome. Обязательный первый этап #11 —
замкнуть сквозной backend-контракт выбранного помола. Это не новая возможность
Gateway: выбор уже принят в [Catalog §3.4](15_CATALOG_IMPLEMENTATION_SPEC.md#34-выбор-помола-оператором)
и отнесён к #11 в `evidence/handoffs/issue-10.yaml`,
`finalDelivery.downstream.orders11`.

Этот документ уточняет и supersede-ит **только** следующие прежние ограничения
[Orders](17_ORDERS_IMPLEMENTATION_SPEC.md), [Pricing](16_PRICING_IMPLEMENTATION_SPEC.md)
и [convergence](19_AROMA_CONVERGENCE_IMPLEMENTATION_SPEC.md): отсутствие помола
в proof/Order и агрегацию физически разных строк исключительно по `offerRef`.
Остальные safety, ownership, deadlines, durability и acceptance сохраняются.
Ни один canonical revision root не изменяется.

## 2. Единственная wire-форма

`sourceGrindKeyHash` — optional lowercase hex SHA-256, ровно 64 символа.
Raw grind ID не покидает Gateway. Отсутствующее поле означает **отсутствие
выбора**, не первый вариант, не пустую строку, не `null` и не wildcard.

| Существующий контракт | Утверждённое расширение |
|---|---|
| `client-v1.CatalogProductSummary` | optional `grindOptions: [{sourceGrindKeyHash, displayName}]` из активного Catalog snapshot |
| `internal-v1.CatalogPricingInput` | такой же optional `grindOptions`, привязанный к тому же product/variant/offer и snapshot revision |
| `client-v1.PricingQuoteCreateLine` | optional `sourceGrindKeyHash` |
| `client-v1.PricingQuoteLine` | optional `sourceGrindKeyHash`; при его наличии обязательный `grindDisplayName` из authoritative Catalog snapshot |
| `internal-v1` request выбранной строки quote verify | optional `sourceGrindKeyHash` как часть ожидаемой строки |
| `internal-v1` verified quote line | тот же hash и `grindDisplayName`, скопированные из сохранённой котировки |
| `client-v1.OrderItemPutRequest` | optional `sourceGrindKeyHash`, сверяемый с quote line |
| `client-v1.OrderItem` | optional `sourceGrindKeyHash` и при его наличии обязательный сохранённый `grindDisplayName` |
| `internal-v1.AromaCartLine`, `AromaSetQuantityRequest`, `AromaRemoveLineRequest` | использовать уже существующий `sourceGrindKeyHash`, второй формат не вводить |

Все объекты остаются закрытыми (`additionalProperties: false`); ограничения
пары hash/display name выражаются runtime JSON Schema, не только TS. Display
name обязано быть непустым. В справочнике hash уникальны, malformed/duplicate
options не допускаются. Отсутствие `grindOptions` означает отсутствие
подтверждённых вариантов; UI не выдумывает значения. Пустой список не разрешает
передать произвольный hash. Отсутствие выбора допустимо и при непустом списке.

Ни новый endpoint, ни браузерный доступ к InternalApi/Gateway не нужны.
`contracts/openapi/{client-v1,internal-v1}.yaml`, JSON Schema, generated
transport types, runtime schemas/validators и fixtures обновляются одним
владельцем в #11 по ADR-0022/0026. Имена существующих операций, trust surface,
permissions, idempotency scope и маршруты сохраняются.

## 3. Catalog, Pricing и локальность Confirm

Catalog read path отдаёт уже сохранённый `grind_options` из своей активной
projection. Orders/браузер не читают Catalog DB; синхронизация/activation и
base `offerRef` не меняются. Синтетические offer/variant на каждый помол запрещены.

Pricing при создании quote проверяет выбранный hash по `grindOptions` той же
authoritative строки Catalog. Неизвестный/недоступный выбор даёт `422
PRICING_GRIND_NOT_AVAILABLE`, без quote/idempotency business success. Неполный
или malformed owner response — существующий unavailable/fail-closed путь,
не разрешение продолжить без помола. Новый код документируется в OpenAPI и
в соответствующем registry ошибок; transient ошибки не превращаются в 422.

Перед положительной физической мутацией convergence также запрашивает только
read-only `CatalogPricingInput` через scoped api-internal mTLS. Catalog подтверждает
точный offer/hash по latest complete active snapshot; missing, stale, unavailable
или malformed proof блокирует mutation. Чтение идёт через Catalog owner API, без
доступа Orders к чужой БД и без provider live lookup.

Pricing сохраняет hash и display name в immutable quote line, включает их в
canonical quote hash и internal proof; verify сверяет ожидаемый hash с
сохранённым (включая точное совпадение отсутствия). Выбор помола **не меняет
ценовую формулу**, unit/minor arithmetic, discount rules или TTL. Идентичность
строки quote для duplicate guards расширяется с product/variant до
product/variant/выбор помола: разные помолы могут иметь разные lineNumber.

Orders PUT использует существующий private quote verify, сверяет весь
product/variant/quantity/grind tuple и сохраняет подтверждённые hash/display
name. Несовпадение помола — существующий `ORDER_QUOTE_SCOPE_MISMATCH`; браузер
не назначает display name и не передаёт authoritative snapshot. Hash запроса
для idempotency включает выбор: изменение выбора с прежним ключом не replay
нового намерения. Reauth/bodyless replay сохраняет исходный результат.

Confirm по-прежнему проверяет только persisted snapshots локально и атомарно
пишет status/version/History/contribution/Outbox. Ни Catalog, ни Pricing, ни
Gateway не вызываются из Confirm. Последующее исчезновение выбранного помола
не разрешает заменить его; Gateway reject/recovery остаётся fail-closed.

## 4. Storage и физическая идентичность

Только forward-only migrations после имеющихся миграций соответствующего
owner. Pricing сохраняет выбор в своей БД, Orders — в своей. Права на core
Order tables остаются у `orders-service`; workers не получают их UPDATE.

Логический line key внутри единственного `aroma-primary`:
`(offerRef, sourceGrindKeyHash-or-absence)`. Packing для новых команд фиксирован
подтверждённой политикой `Aroma`; физическая identity включает также packing.
Gateway уже отвергает snapshot с иной/неподтверждённой упаковкой. `packing=null`
не нормализуется в `Aroma`; новый packing selector/формат API не вводится.

Новый ключ используется согласованно в contribution lines, Desired lines,
Observed lines, deterministic diff, reservation payload, operation hash,
verification/recovery и per-Order proof. Агрегация только внутри одинакового
ключа. Сортировка: `offerRef`, затем отсутствие выбора перед hash,
затем лексикографический hash. Selected hash входит в canonical hashes;
display name не является физической identity и не меняет target quantity.
При этом snapshot display name остаётся частью immutable quote proof.

В SQL optional hash хранится nullable; уникальность отсутствующего выбора
обязательна: составной `UNIQUE NULLS NOT DISTINCT` по полному line key.
Nullable колонка в обычном PK недопустима. Для подтверждённого отсутствия
используется один нормализованный ключ, не две параллельные реализации.

Уже существующие строки без выбора означают отсутствие выбора. Их immutable
quote/contribution hashes и сохранённые idempotency response bytes не
переписываются, Confirm не повторяется, новые события задним числом не создаются.
Канонизация без выбора сохраняет прежние байты; для выбранного hash добавляет
явные поля в детерминированном порядке. Это один алгоритм optional-полей, не
legacy worker. Миграционный тест проверяет старые snapshots и exact replay.

Quantity transport Gateway принимает целые упаковки/штуки. Orders хранит
`quantityMilli`: в mutation допускается только точное деление на 1000,
результат положителен и не больше `Number.MAX_SAFE_INTEGER`. Никаких rounding,
unit conversion и передачи milli как упаковок. Если persisted contribution
непредставим, preparation сохраняет blocker `AROMA_QUANTITY_NOT_SUPPORTED`,
не отправляет mutation и не скрывает contribution. Код blocker добавляется в
owning contract/registry с тестом. Zero Desired означает remove точного line key.

## 5. Два последовательных этапа одной задачи #11

**A — backend contract closure.** Catalog read, Pricing snapshot/verify,
Orders PUT/Card/contribution и forward migrations по разделам 2–4;
OpenAPI/runtime schemas/types-only generation/fixtures и проверки.
Исполнитель предъявляет архитектору actual diff и evidence. Бумажный контракт
не означает готовность generated types или разрешение произвольных casts в UI.

**B — observer/convergence.** Использовать результат A для Inbox, mapping,
Desired/Observed, Attempt/Lease/Fence/Reservation, durable scheduler/recovery
и projection. Все существующие обязательные failure/capacity tests #11
сохраняются. Финальная приёмка #11 объединяет A и B, не закрывается одним A.

Дополнительно применяется [ADR-0032](../adr/ADR-0032-order-reconciliation-intent.md):
preparation потребляет `OrderReconciliationRequested.v1`, читает current owner
facts и создаёт durable `AromaConvergenceRequested.v1(reason=OperatorRequested)`.
Неизменившийся Desired hash не подавляет операторский wake-up и сам по себе
не требует increment revision. Нет фактов — нет выдуманного cartScope/revision
и нет successful no-op/Inbox success. Public order-level `202` shell не дублировать.

## 6. Параллельность и файловые границы

- #11: отдельный worktree/ветка `feature/11-aroma-convergence` от принятого
  `develop`; три worker apps, owning Orders migrations/runtime, необходимые
  Catalog/Pricing contract paths, `contracts/**`, соответствующие generated
  packages и validators, backend tests и handoff.
- #9: `apps/web/**`, browser fetch/cache/forms/accessibility и UI tests; UI
  показывает `grindOptions`, сохраняет явный выбор и передаёт hash одинаково в
  quote/PUT; смена выбора инвалидирует quote. Не пишет backend/общие контракты.
- #11 не изменяет `apps/web/**`, `packages/platform-ui/**`, browser-only package
  manifests и UI tests. #9 не вводит второй DTO/validator или свою wire-форму.
- Root `package.json`, `pnpm-lock.yaml`, `config/**`, `platform/**`, общие
  fixtures/документы изменяются с явной координацией; нельзя переносить поверх
  незакоммиченной работы другого исполнителя. Новые dependencies/frameworks
  этим решением не разрешены.
- Полный #11 не становится predecessor старта #9. Независимые UI части можно
  делать сейчас. **Приёмка сквозного выбора помола в #9 требует проверенного
  выхода этапа A**, а приёмка #11 требует wire-consumer compatibility proof.
  Это частичный integration gate, не цикл #9↔#11 и не фиктивный PASS на fixture.
- После готовности A архитектор координирует перенос контрактного delta в #9 и
  совместную проверку; исполнитель не делает самостоятельные commit/cherry-pick/
  push/PR/merge. Никакой автоматической публикации из статуса `ready`.

## 7. Обязательное доказательство

Расширить подходящие существующие tests; не создавать новый test framework.

1. Catalog отдаёт выбранные варианты из active snapshot; raw IDs не выходят.
2. Unknown grind rejected; отсутствие не превращается в default; malformed
   options fail closed. Same offer/different grind — разные quote/Order lines.
3. Quote hash/internal proof/idempotency различают выбор; verify/PUT mismatch
   rejected; Card содержит сохранённый выбор; browser не назначает display name.
4. Два заказа с одинаковым offer/одинаковым hash агрегируются, с разными — нет;
   отсутствие выбора — отдельная строка; строки не теряются после restart.
5. Desired/Observed/diff/reservation/recovery сопоставляют exact physical key;
   remove одного помола не затрагивает другой; wrong packing не нормализуется.
6. milli→provider exact conversion, fractional/overflow blocker, без rounding.
7. Existing no-selection persisted data, immutable hashes и exact/bodyless
   replay после migration; Confirm не получает внешних вызовов.
8. Order-level operator intent при unchanged Desired всё равно durable wake-up;
   duplicate message не создаёт повторный эффект. Все исходные fence/reservation,
   lost response/in-flight/crash/failed GET сценарии #11 остаются обязательными.
9. Live PostgreSQL proofs owner migrations/transactions, generated zero diff,
   contract/architecture/lint/typecheck, isolated Compose recovery. Real provider
   mutations и production credentials для local acceptance не требуются.

## 8. Предел разрешения

Разрешены локальная реализация и проверки по этому документу и live #11.
Commit, push, создание PR, merge, deployment, provider mutations и изменения
production требуют отдельного разрешения владельца. Архитектурные изменения
за этими границами передаются архитектору; исполнитель не расширяет scope сам.
