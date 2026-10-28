# ADR-0038: границы первой read-only итерации Tasty

- Статус: **Proposed**. Только владелец Architecture может явно принять ADR;
  merge или закрытие #186 само по себе не означает Accepted или разрешение кода.
- Дата: 2026-10-28. Scope: архитектурное предложение, без изменения runtime.
- Основание: [scope](../launch/00_SCOPE_AND_DECISIONS.md),
  [ownership](../launch/05_DATA_OWNERSHIP.md), [delivery graph](../launch/13_DELIVERY_DEPENDENCY_GRAPH.md),
  принятые исследования [каталога](../integrations/tasty/catalog.md),
  [идентичности](../integrations/tasty/identity.md),
  [денег](../integrations/tasty/money.md) и [сессии](../integrations/tasty/session.md).

## Предложение: владельцы и границы

Catalog, Pricing и Orders остаются общими ограниченными контекстами и сохраняют
своё владение: Catalog — товарами, предложениями, mapping и supplier snapshots;
Pricing — policy и quote; Orders — заказами и принятыми соглашениями. Их данные
не копируются в отдельные Tasty-сервисы; общие изменяемые сущности и
межвладельческий SQL запрещены. Новый Gateway не владеет этими бизнес-данными.

Предлагается отдельный будущий процесс `tasty-gateway` внутри Integration:
Bearer/session, origin и профиль отказов отличаются от AROMA, поэтому его
credentials и сбои изолируются от AROMA и бизнес-владельцев. Он обслуживает
только разрешённые чтения каталога и корзины Tasty по `GET`. `POST /auth/login`
для будущей авторизации — отдельная операция получения сессии, не бизнес-мутация;
в рамках #186 никаких HTTP-запросов и login не выполняется. Установка, удаление,
merge корзины, checkout и новая convergence в первую итерацию не входят.

`supplier` обозначает поставщика; `account` — область авторизации у поставщика;
`cartScope` — конкретную область корзины. Они не взаимозаменяемы, связь account
и cartScope для Tasty **NOT_PROVEN**. Предлагается инвариант «один supplier на
Order», включая проверку принадлежности всех его offer; это не утверждение о
текущей реализации Orders. Мультипоставочный Order и запись корзины требуют
отдельного решения. Первая read-only итерация не создаёт Tasty quote или Order,
не выполняет Confirm и не включает Tasty в действующие AROMA write paths; #201
предназначена только для просмотра. Ошибка или неполное чтение не превращаются
в пустой snapshot и не меняют последний подтверждённый бизнес-факт.

В будущем credentials materialize-ит trusted `config-bootstrap` только для
`tasty-gateway` из encrypted SOPS в scoped tmpfs; browser, Catalog и Orders не
получают provider credentials. Доступ к provider origin и операциям ограничен
allowlist; произвольный origin, путь и redirect с credentials запрещены. Internal
caller и account/cartScope проверяются до вызова, полные provider body, адреса,
Bearer и credentials не попадают в логи, browser или события. Секреты не
появляются в данном ADR; точные scopes, service identity, маршруты, permissions,
deadlines, лимиты и условия повторной авторизации требуют отдельной конкретизации
и доказательств до реализации. Объявленный TTL не доказывает срок жизни токена.

## Что показывает текущий код

Это указатели на существующий AROMA-путь, не готовая реализация Tasty и не
разрешение переименовать AROMA contracts.

| Код | Проверенная граница |
|---|---|
| [decoder.ts](../../apps/aroma-gateway/src/infrastructure/provider/decoder.ts) `decodeCatalogPage` / `ProviderCatalogPage`, [provider-errors.ts](../../apps/aroma-gateway/src/domain/provider-errors.ts) `ProviderError` и [provider-catalog-source.ts](../../apps/aroma-gateway/src/application/provider-catalog-source.ts) `checkedPage` | AROMA decoder читает pagination metadata и различает неполные/невалидные данные; source проверяет последовательность страниц. Это не доказательство pagination Tasty. |
| [cart-reader.ts](../../apps/aroma-gateway/src/application/cart-reader.ts) `ProviderCartReader` | Проверяет `defaultPacking`, возвращает `cartScopeRef: "aroma-primary"`; это AROMA-specific поведение. |
| [catalog-supplier-sync/main.ts](../../apps/catalog-supplier-sync/src/main.ts) `AROMA_SUPPLIER_REF` | Scheduler передаёт фиксированный AROMA supplier при импорте. |
| [activation-store.ts](../../apps/catalog-activation-worker/src/infrastructure/activation-store.ts) `finishPrepared`, `AromaOfferBindingRequest`; [offer-binding-store.ts](../../apps/aroma-gateway/src/infrastructure/database/offer-binding-store.ts) `SCHEME`, `resolveByProviderIdentity` | Текущий binding связан с AROMA и его identity scheme; Tasty нельзя выдавать за AROMA binding. |
| [catalog-client.ts](../../apps/pricing-service/src/infrastructure/catalog-client.ts) `createCatalogPricingClient` | Pricing ожидает доступный Catalog input с `currency: "RUB"` и целочисленной строкой `supplierUnitMinor`; source Tasty в копейках пока не доказан. |
| [order-store.ts](../../apps/orders-service/src/infrastructure/database/order-store.ts) `RequestReconciliation`, `AROMA_RECONCILIATION_NOT_ALLOWED` | Текущий путь reconciliation адресован AROMA; он не доказывает реализованное универсальное разделение supplier в Orders. |
| [aroma-gateway/main.ts](../../apps/aroma-gateway/src/main.ts) `providerOrigin`, `requiredSecretString`; [http-client.ts](../../apps/aroma-gateway/src/infrastructure/provider/http-client.ts) `ProviderHttpClient` | Текущий AROMA использует scoped runtime secrets, проверенный HTTPS origin и cookie transport. Tasty Bearer нельзя считать тем же протоколом. |

## Предлагаемые локальные decoder boundaries

Имена, пути и коды ниже — предложение для чистых функций Integration, а не
существующие runtime contracts, wire schema или обещание общей библиотеки.
Исторические parsed summaries и выбранные поля — не raw decoder corpus и не
доказывают обязательность каждого поля или полную форму ответа. Конкретные
поля, их типы, обязательность и входной формат фиксируются только после
получения подтверждённых входов; synthetic fixtures маркируются как synthetic.

| Будущая задача | Предлагаемые source/test paths, символы и ошибки | Требуемая граница |
|---|---|---|
| #187 Catalog | `apps/tasty-gateway/src/infrastructure/provider/catalog-decoder.ts`; `tests/tasty/catalog-decoder.test.mjs`; `decodeTastyCatalogResponse`, `TastyCatalogResponse`, `TastyCatalogProduct`, `TastyCatalogOffer`; `TASTY_CATALOG_INCOMPLETE`, `TASTY_CATALOG_INVALID`, `TASTY_CATALOG_MONEY_NOT_PROVEN` | Различать product и offer identity, доступность обоих уровней, weight, quantity, grind и package по подтверждённым данным соответствующего offer. Не выводить единицу `weight` или единицу и семантику `quantity_kg` из имени, не подменять omission и null значениями по умолчанию. Filtered empty не подтверждает полноту каталога; decoder одного ответа не доказывает полный обход. |
| #188 Cart | `apps/tasty-gateway/src/infrastructure/provider/cart-decoder.ts`; `tests/tasty/cart-decoder.test.mjs`; `decodeTastyCartResponse`, `TastyCartSnapshot`, `TastyCartLine`; `TASTY_CART_INCOMPLETE`, `TASTY_CART_INVALID`, `TASTY_CART_UNSUPPORTED_LINE` | Различать product/offer и текущий row ID, grind, package и quantity; row ID может измениться. Null и omission не приравниваются и не заполняются догадкой. Неизвестная специальная строка отклоняется, malformed/partial/error не становятся пустой корзиной. Полная схема cart и критерий пустого complete ответа **NOT_PROVEN**. |

Raw provider IDs допустимы только в private Gateway boundary; они не выходят
в browser или events. Не назначать package или grind автоматически без
доказанного контракта. Цену offer, cart total и клиентскую цену различать;
исходный decimal lexeme, валюта, масштаб и правило округления должны быть
доказаны до money normalization. Из общего cart total нельзя выводить
закупочную цену строки без доказанного распределения. Исторический parsed float
не восстанавливает raw lexeme; discount 30 относится только к наблюдённому
контексту. Молчаливое округление неоднозначных цен запрещено.

Существенные **NOT_PROVEN** блокируют реализацию #187/#188: нужны подтверждённые
полные входы decoder и контракт поля/наличия, для #187 — также доказанная
денежная точность и валюта, для #188 — полная структура и критерий complete cart.
Привязка account/cartScope отдельно блокирует transport/runtime и internal read
#196/#202; чистый decoder не определяет авторизацию или выбор аккаунта.
Для полного export и activation дополнительно необходим подтверждённый способ
полного обхода и сигнал завершения; число 423 и filtered empty не являются
критерием. Accepted ADR без этих данных не снимает блокировку. При явном
принятии владельцем перенести exact paths, types, errors и подтверждённые входы
в bodies #187/#188 до изменения readiness; этот ADR issues не меняет. Принятие
фиксирует только владелец Architecture явным решением; после него обновление
issues и readiness выполняется отдельно при наличии нужного разрешения и
доказанных входов. До принятия никаких таких изменений не требуется.

## Последовательность после принятия

Работа ведётся в отдельных worktree от актуальной `develop`; общий dirty-кандидат
#13 не меняется. Изолированные offline #187/#188 могут готовиться отдельно от
#13 только после Accepted ADR и доказанных входов. #194/#195 могут готовить
ограниченный HTTP/session код по принятым входам отдельно от #13; локальные
fixtures не доказывают live поведение. Подключение в launch/runtime и общие
Catalog/Orders/config изменения ждут merge #13 и остальные prerequisites:

- #194 — ограниченный HTTP-клиент безопасных чтений; #195 — session в памяти.
- #196 — read-only Gateway runtime со scoped доступом; #197 — внутренний поток каталога.
- #198 — активные поколения Catalog по supplier; #199 — dispatch существующего importer.
- #200 — supplier-aware поиск и Pricing input; #201 — просмотр каталога в React.
- #202 — типизированное внутреннее чтение корзины с проверенным scope.

Для каждой задачи Accepted ADR, принятые handoff, точная source/schema/config/test
конкретизация и её собственные доказательства обязательны до readiness. Здесь
не вводятся миграции, OpenAPI/events, runtime/config/Compose, дополнительная БД,
новая test infrastructure или универсальный framework поставщиков.
