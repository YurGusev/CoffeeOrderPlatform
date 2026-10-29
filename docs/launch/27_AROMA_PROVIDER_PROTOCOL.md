# AROMA: исследованный HTTP-протокол для issue #10

Статус на 2026-09-12: safe reads и login на основном host подтверждены;
ограниченный cart add/set/remove сценарий подтверждён отдельно ниже;
общие quantity bounds, UI-лимиты и часть identity semantics ещё не доказаны.
Документ фиксирует исследование наблюдаемого поведения, а не готовность adapter
или #10; он не является handoff готового Gateway и не разрешает provider mutations.
Техническая authority Platform — [ADR-0025](../adr/ADR-0025-fastify-launch-recovery.md),
внутренний wire contract — [InternalApiV1](../../contracts/openapi/internal-v1.yaml).

## Действующее уточнение от 18 сентября 2026

Исторические таблицы ниже описывают свои выборки, а не текущий delivery status.
Владелец подтвердил целые упаковки/штуки и упаковку `Aroma`; оператор выбирает
помол из справочника `GET /api/v1/catalog/grinds`. Gateway передаёт наружу только
`sourceGrindKeyHash` и название, выбранный hash входит в journal и физическую
identity строки. Отсутствующий помол означает отсутствие выбора, а `packing=null`
в существующей корзине не приравнивается к `Aroma`.

Полный [read-only export](../../evidence/aroma-provider/2026-09-18-complete-catalog-export.json)
прошёл 47 страниц: 464 продукта, 806 offers, 119 ground offers с 12 вариантами
помола. JSON decimal price читается точно из исходного токена; одна отсутствующая
фотография передана как `imageUrl: null`. Quantity admission — положительные
целые до `Number.MAX_SAFE_INTEGER` как технического transport ceiling. Это не
заявление о глобальных ограничениях поставщика. Динамические rejects и
неопределённые post-dispatch outcomes обрабатываются без повторной mutation.

Текущие проверки и ограничения: [финальный delivery evidence](../../evidence/issue-10-final-delivery.md).
Реализация UI/Orders/Catalog consumers остаётся в их issues; она не переносится
в Gateway. Provider mutations в этом финальном цикле не выполнялись.

## Происхождение сведений

Исследован локальный CoffeeOrderSystem, commit
`0bf3b7d525444fee1a190bd86fc8b9500a709662`; перечисленные файлы без локальных
изменений. Пути ниже относительны корню **System**, не Platform:

| Источник                                                                                               | Участок и значение                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `docs/Интеграция/01_Архитектура_интеграции_AROMA.md`                                                   | §11.3–12: историческая проверка login от 2026-04-24, hosts и cookies                            |
| `src/CoffeeOrderSystem.Modules.Orders/Infrastructure/Integrations/Aroma/AromaSessionRefreshService.cs` | `CreateLoginRequest`, `ProbeAsync`, `ApplySetCookieUpdates`: login и обновление сессии          |
| `src/CoffeeOrderSystem.Modules.Orders/Infrastructure/Integrations/Aroma/AromaCartReadClient.cs`        | `CreateCartReadRequest`, `ParseSuccessResponse`, payload types: чтение корзины                  |
| `src/CoffeeOrderSystem.Modules.Orders/Infrastructure/Integrations/Aroma/AromaCartClient.cs`            | `CreateCartAddRequest`, `CreateCartUpdateRequest`, `CreateCartDeleteRequest` и callers: мутации |
| `src/CoffeeOrderSystem.Modules.Orders/Infrastructure/Integrations/Aroma/AromaCartResponseValidator.cs` | `ValidateAddedItem`, `ValidateCartItemQuantity`: интерпретация успешных ответов                 |
| `src/CoffeeOrderSystem.Modules.Catalog/Infrastructure/External/AromaCatalogLookupService.cs`           | `BuildFullSnapshotUri`, `FetchPageAsync`, `ValidateSnapshotPage`, payload types: каталог        |

Это свидетельства документации и поведения клиента. Unit tests System с
`StringContent`/подставными HTTP handlers — синтетические fixtures, не captures.
Актуальная live-выборка 2026-09-08 сохранена только в обезличенном виде в
[`evidence/aroma-provider/`](../../evidence/aroma-provider/); raw responses не
сохранялись. Проверка 2026-04-24 — историческое утверждение документа, не
выполненная в этой задаче live-проверка. Runtime-код, DB-модели, типы и
артефакты System в Platform не переносятся.

## Методы, пути и payload по System

Все пути ниже относятся к provider API, а не к InternalApiV1.

| Операция              | Запрос                                                                                                            | Интерпретация ответа в System                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Login                 | `POST /api/v1/auth/login`, JSON `{email,password}`                                                                | Успешный status и обязательные cookies; затем probes                                                                           |
| User probe            | `GET /api/v1/user`                                                                                                | Успешный HTTP status                                                                                                           |
| Cart read             | `GET /api/v1/cart/?timestamp=<ISO time>`                                                                          | JSON object с `products`                                                                                                       |
| Полный каталог        | `GET /api/v1/catalog/wholesale/products?page=1&per_page=<page size>` и следующие страницы                         | JSON `{data,meta}`                                                                                                             |
| Добавление строки     | `POST /api/v1/cart/?timestamp=<ISO time>`, form-urlencoded `offer_id`, `quantity`, `packing`, optional `grind_id` | JSON корзины с целевой позицией; возможна ошибка даже в 2xx                                                                    |
| Абсолютное количество | `PUT /api/v1/cart/{cartItemId}?timestamp=<ISO time>`, JSON `quantity`, `packing`, optional `grind_id`             | JSON корзины с целевой строкой                                                                                                 |
| Удаление строки       | `DELETE /api/v1/cart/{cartItemId}?timestamp=<ISO time>`, без body                                                 | В controlled-сценарии 2026-09-12 удаление дало 200, повторное удаление той же строки — 404; это не общая гарантия provider 404 |

Cart requests используют `Accept: application/json`, `x-timestamp`, `Origin`,
`Referer: <origin>/lk` и Gateway-owned `Cookie`. Login использует Accept,
Origin и Referer. Каталог добавляет Accept и x-timestamp; его метод
`FetchPageAsync` явно не добавляет Cookie. Требуемые provider headers и auth
каталога ещё подлежат актуальной проверке; отсутствие header в этом методе
само по себе не доказывает отсутствие auth в полном HTTP pipeline.

System обрабатывает `Set-Cookie` после login и последующих ответов.
Документ называет `aroma_auth`, `october_session`, companion `dcCNXv`.
Platform должна проверять domain/path/secure/expiry cookies, запрещать redirects
и не выпускать session в DTO, journal, logs и errors. Обязательность каждого
companion cookie и срок сессии нельзя вывести из одних имён.
Legacy retry/storage policy не переносится: после возможного unsafe dispatch
никакой re-auth не повторяет мутацию; журнал следует
[спецификации Dispatched barrier](22_AROMA_GATEWAY_OPERATION_JOURNAL.md).

## Формы ответов и строгий decode Platform

Корзина: `products[]` содержит `id` (ID строки корзины), `offer.id` (ID
предложения), `quantity`, `packing`, `grind_id`; дополнительные поля System —
`offer.name`, `offer.vendor_code`, `offer_name`, `product_name`.
Документация исторического probe также упоминает `prices`.

Legacy read подставляет пустой массив при отсутствии `products` и отбрасывает
строки с невалидным offer ID. Platform должна отклонять такой ответ полностью:
неполное тело, отсутствующий массив, duplicate identity и invalid quantity
никогда не означают пустую корзину. Только полностью полученный и проверенный
ответ может дать snapshot. Provider fingerprint в прочитанном payload не найден;
внутренний `cartFingerprint` нельзя выдавать за полученный от провайдера proof.

Каталог: `data[]` содержит product `id`, `name`, `product_on_stop`,
`show_on_wholesale`, `category.{name,slug}`, `offers[]`, `discount[]`.
Offer содержит `id`, `name`, `vendor_code`, `price`, `params[]` с
`param.{name,slug}`, `param_value.value`, `value`.
Discount содержит `id`, `discount`, `min_weight`, `created_at`, `updated_at`.
`meta` содержит `current_page`, `total`, `last_page`, `per_page`.
System проверяет номера страниц, стабильность total/last_page и итоговое
количество products. Это не доказательство snapshot isolation у provider.

Provider отдаёт paginated JSON, а не внутренний NDJSON. Platform преобразует
его потоково в четыре records из
[Catalog specification](15_CATALOG_IMPLEMENTATION_SPEC.md), соблюдая
backpressure, лимиты и terminal semantics. Сборка полного каталога в список из
System не подходит. Currency, единицы price/quantity, variant identity и
отображение availability требуют явного подтверждения; тип `decimal` клиента
не определяет эти свойства provider.

Legacy validator количества принимает `actual >= requested`. Для абсолютного
set этого недостаточно: Platform требует точного результата согласно
подтверждённому протоколу; malformed/неоднозначный ответ после dispatch даёт
`ProviderOutcomeUnknown`. Raw `error`/`errors` и тексты ответов наружу не выходят.
Неподтверждённый 4xx после dispatch нельзя автоматически считать доказательством
отсутствия эффекта. Таймаут, обрыв, 401/re-auth ambiguity не разрешают resend.

## Разрывы, требующие решения до рабочего adapter

1. **Origin.** Согласованный fixed HTTPS origin для Gateway —
   `https://aromateacoffee.ru`; он задан в Platform config и его `const` в
   [config schema](../../config/platform.schema.json), а outbound/permission
   allowlists остаются Gateway-only. Новый сетевой вызов этим изменением не
   выполняется. Ни второй origin, ни redirect fallback не добавляются
   автоматически; capabilities на origin остаются непроверенными.
2. **Цепочка идентификации.** Внутренний binding уже частично реализован:
   `InternalApiV1` содержит `registerAromaOfferBinding` для immutable binding
   ([контракт](../../contracts/openapi/internal-v1.yaml#L195)). Он связывает
   `offerRef`, supplier/snapshot и `sourceOfferKeyHash`, но не экспортирует raw
   provider offer ID. Production export из Gateway в Catalog остаётся
   незавершённым; для cart read Gateway-local resolution теперь выполняет
   `ProviderCartReader` через `OfferBindingStore.resolveByRawProviderOfferId`.
   Каждый provider offer ID должен иметь ровно одну bound `offerRef`; missing или
   ambiguous mapping даёт typed failure, а raw ID не выходит в DTO.
   Свежая provider-корзина по-прежнему разрешает только `provider offer ID → cartItemId`,
   а не связь с `Catalog offerRef`. HMAC необратим; `offerRef` нельзя
   подставлять в provider URL. Существующий binding уже связывает
   `offerRef` с source identity; незавершены его production-наполнение и
   catalog export. Cross-owner SQL и перенос raw IDs наружу запрещены. Это касается
   и преобразования cart read в `{offerRef,quantity}`: оно подключено только для
   complete snapshot и не очищает состояние при failed/partial GET.
   Catalog export traversal provenance is `aroma-gateway:catalog-export:<snapshotRef>`;
   `snapshot-started.providerSnapshotRef` carries this reference unchanged and is
   not a precomputed content hash. The account scope is `aroma-primary` and the
   canonical supplier is `sup_00000000000000000000000001`; `aroma.email` and
   `aroma.password` remain Gateway-only secrets.
3. **Отсутствующая строка и варианты.** Для положительного set отсутствующей
   строки нужен provider offer ID для POST, которого нет в свежей корзине.
   POST/PUT также используют packing/grind; InternalApiV1 их не принимает.
   Нужно определить, какие варианты покрывает offer identity и что делать при
   нескольких provider lines для одного offer. Складывать дубли или выбирать
   произвольный cartItemId запрещено. DELETE 404/no-op и отсутствие строки до
   dispatch требуют подтверждённой семантики.
4. **Количество.** System использует C# `int`, внутренний `ProviderQuantity` —
   strictly positive decimal string для `Set`; zero выражается отдельной
   операцией `Remove`. Journal хранит strictly positive `quantity_milli bigint`
   для `SetLineQuantity` и `NULL` для `RemoveLine`. Ни максимальное значение, ни
   допустимая дробность/единица provider из этого не следуют. Issue #10 требует
   доказанных provider bounds до production mutation adapter/merge.

## Безопасная live-проверка 2026-09-08

Наблюдения выполнены последовательно на фиксированном
`https://aromateacoffee.ru`: TLS verification включена, redirects запрещены,
timeout 15 секунд для публичных GET и 20 секунд для login/session probe, лимит
чтения 2 097 152 байта. Login выполнен один раз в финальном probe с
расшифровкой encrypted import только в памяти; credentials, cookie values и
provider bodies не выводились и не сохранялись. POST/PUT/DELETE корзины,
заказы, платежи и изменения профиля не выполнялись.

В финальном probe публичные GET отправлялись только с `Accept` и техническим
`User-Agent`; authenticated GET использовали CookieJar после login. Login
отправлял JSON с `Content-Type`, `Origin` и `Referer`. `timestamp` query и
`x-timestamp`, которые присутствуют в legacy System-клиенте, в этом probe не
отправлялись. Успех чтения без них не доказывает их необязательность для
mutation или полного provider HTTP pipeline.

| Время UTC            | Авторизация   | Метод и путь                                                  | Status / content-type    | Полнота и наблюдение                                                                                                                                                                               |
| -------------------- | ------------- | ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08T15:09:11Z | public        | `GET /api/v1/catalog/wholesale/products?page=1&per_page=10`   | 200 / `application/json` | 167 195 bytes, полное тело; `data` 10, `meta`: `current_page=1`, `from=1`, `to=10`, `last_page=47`, `per_page=10`, `total=466`; response установил cookies                                         |
| 2026-09-08T15:04:56Z | public        | `GET /api/v1/catalog/wholesale/products?page=47&per_page=10`  | 200 / `application/json` | 171 671 bytes, полное тело; `data` 6, `meta`: `current_page=47`, `from=461`, `to=466`, `last_page=47`, `per_page=10`, `total=466`; `links` содержат абсолютные URLs с host `dev.aromateacoffee.ru` |
| 2026-09-08T15:11:27Z | public        | `GET /api/v1/user`                                            | 403 / `application/json` | 39 bytes, полное тело; top-level `{error}`                                                                                                                                                         |
| 2026-09-08T15:11:27Z | public        | `GET /api/v1/cart/`                                           | 403 / `application/json` | 39 bytes, полное тело; top-level `{error}`                                                                                                                                                         |
| 2026-09-08T15:13:58Z | public        | `GET /api/v1/catalog/wholesale/products?page=233&per_page=10` | 200 / `application/json` | 2 110 bytes, полное тело; `data=[]`, `meta.current_page=233`, `meta.last_page=47`, `meta.total=466`                                                                                                |
| 2026-09-08T15:04:57Z | authenticated | `POST /api/v1/auth/login`                                     | 200 / `application/json` | 678 bytes, полное тело; top-level `{data}`, cookies установлены                                                                                                                                    |
| 2026-09-08T15:04:58Z | authenticated | `GET /api/v1/user`                                            | 200 / `application/json` | 678 bytes, полное тело; top-level `{data}`, email совпал с import только при in-memory сравнении                                                                                                   |
| 2026-09-08T15:04:58Z | authenticated | `GET /api/v1/cart/`                                           | 200 / `application/json` | 114 bytes, полное тело; `{prices,products}`, `products=[]`; массивы `prices.categories`, `weights`, `discounts`, `prices` пусты, `prices.total` имеет `default` и `promo`                          |
| 2026-09-08T15:04:58Z | authenticated | `GET /api/v1/catalog/wholesale/products?page=47&per_page=10`  | 200 / `application/json` | 171 671 bytes, полное тело; в этой выборке форма и цены совпали с public read                                                                                                                      |

Для HTML `GET /wholesale` основной host вернул страницу `KillBot user
verification` (`200 text/html`) и не показал каталог, карточки, frontend bundle,
формы или controls количества. Это не обходилось. Поэтому UI↔API price match,
начальное quantity, min/max/step и дробный ввод не наблюдались.

### Цена и варианты в текущей выборке

На первой странице у двух просмотренных чайных offers `price=0` имеет JSON type
`integer`; на последней странице у одного кофе четыре разных offer IDs с
ценами `940` для 200 г и `4500` для 1000 г. В названиях offers присутствует
`Упаковка 200 г`/`Упаковка 1000 г`, а `params[]` содержит:

- `param.slug=weight`, `param_value.value` — строка `200` или `1000`;
- `param.slug=is_grinded`, `value` — строка `0` или `1`, `param_value=null`.

У одного product изменение веса и `is_grinded` в этой выборке соответствует
разным `offer.id`; зерновой и молотый offers с одинаковым весом имеют одинаковую
цену в наблюденном примере. В product response нет `unit`, `currency`, scale,
явной `packing`-параметризации или доказанного price basis; `discount` был
пустым у всех шести products последней страницы и двух просмотренных products
первой страницы. Эти значения доказывают только offer-level observations и не
разрешают формулу пересчёта в рубли, копейки, килограммы или упаковки.

### Cookies и session flow

Наблюдались только свойства cookies, без значений:

| Cookie            | Domain              | Path | Secure      | HttpOnly     | SameSite | Expiry       |
| ----------------- | ------------------- | ---- | ----------- | ------------ | -------- | ------------ |
| `dcCNXv`          | не указан           | `/`  | отсутствует | отсутствует  | `Lax`    | присутствует |
| `october_session` | `aromateacoffee.ru` | `/`  | отсутствует | присутствует | `lax`    | присутствует |
| `aroma_auth`      | `aromateacoffee.ru` | `/`  | отсутствует | присутствует | `lax`    | присутствует |

Public catalog read также установил `dcCNXv` и `october_session`; login добавил
`aroma_auth`; последующие user/cart/catalog reads обновляли
`october_session`. Отсутствие `Secure` — наблюдение provider response, а не
разрешение ослаблять требования Platform. Срок жизни сессии по одному факту
наличия expiry не выводится. Вся успешная цепочка финального probe оставалась
на основном host без redirect.

### Ограничения pagination

Провайдер возвращает `{data,links,meta}`. `meta` стабильно описала выборку
`total=466` и `last_page=47` при `per_page=10`, но `links` направляют на
`dev.aromateacoffee.ru`; их нельзя переходить автоматически. Provider API также
ответил `200` и пустым `data` для ранее проверенного `page=233&per_page=10`, где
`meta.last_page=47`. Adapter должен строить запросы только на configured origin,
проверять page/meta и считать неожиданный пустой page за пределами `last_page`
ошибкой протокола, а не концом snapshot.

## Безопасная live-проверка 2026-09-07

Выполнены неавторизованные GET на `https://aromateacoffee.ru` через Python
`urllib.request`: TLS verification включена, redirect handler запрещает
переходы, timeout 15 секунд, чтение не более 65 537 байт, Accept JSON.
Cookie/credentials не передавались; POST/PUT/DELETE не выполнялись.
Body и Set-Cookie не сохранялись и не выводились. Результаты:

| Путь                                                   | Status / content-type  | Проверенные несекретные признаки                                                                                   |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/api/v1/catalog/wholesale/products?page=1&per_page=1` | 200 / application/json | Полное тело 19 600 байт; object, `data` array длиной 1; meta: current_page=1, last_page=466, total=466, per_page=1 |
| `/api/v1/user`                                         | 403 / application/json | Полное тело 39 байт, JSON object                                                                                   |
| `/api/v1/cart/`                                        | 403 / application/json | Полное тело 39 байт, JSON object                                                                                   |

Это актуальное доказательство доступности первой страницы каталога на основном
host без авторизации и отсутствия redirect в этих трёх запросах. Это не capture
для decoder tests, не полный catalog snapshot, не подтверждение wholesale цен
для рабочего аккаунта и не проверка login/session/cart semantics.
На этом этапе основной host оставался кандидатом до проверки аккаунта;
доступной scoped session materialization в `/run/secrets` не обнаружено.

### Проверка с импортированным аккаунтом

2026-09-07T17:44:43Z пользователь предоставил отдельный encrypted import
`secrets/aroma-import.secrets.sops.yaml` с `aroma.email`/`aroma.password`.
Он расшифрован SOPS/age только в память одноразового probe. Общий inventory не
расшифровывался и не изменялся; import не подключался к runtime. Значения
credentials, cookies и provider bodies не сохранялись и не выводились.

Probe использовал тот же фиксированный `https://aromateacoffee.ru`, TLS
verification, запрет redirects, in-memory CookieJar, timeout 20 секунд и
лимит чтения 2 097 153 байта. После завершения процесса память сессии освобождена.

| Операция                                                                  | Результат                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/login` с JSON email/password                           | 200, application/json, полный JSON object; cookies получены                                             |
| `GET /api/v1/user` с этой сессией                                         | 200, application/json, полный JSON object; email в ответе совпал с импортированным (сравнение в памяти) |
| `GET /api/v1/cart/` с этой сессией                                        | 200, application/json, полный JSON object, `products: []`                                               |
| `GET /api/v1/catalog/wholesale/products?page=1&per_page=1` с этой сессией | 200, application/json, полный JSON object, один product в `data`                                        |

Login и все три чтения работают на одном основном host для предоставленного
аккаунта без redirect. Это закрывает вопрос доступности этих endpoints с
единой сессией. Placeholder/allowlists пока не изменены; runtime admission
и перенос import в основной inventory этой проверкой не выполнялись.
Корзина пустая: форма непустой строки, диапазон/дробность quantity, packing/grind,
mutation ack/reject и DELETE missing-line этим probe не проверены.
Provider cart mutations не выполнялись. Не проверены полный каталог, цены
рабочего аккаунта и истечение/refresh сессии. Captures для decoder tests не
создавались; сохранены только несекретные результаты выше.

### Актуальный read-only probe 2026-09-18

После реализации Gateway выполнен отдельный bounded read-only probe через scoped
runtime materialization и production `ProviderHttpClient`/`ProviderSessionManager`.
Изначальный бюджет был один login и до шести safe reads. Из-за двух локальных
ошибок observation wrapper фактически выполнены три login и шесть safe reads;
ошибка происходила после успешного чтения catalog page 1 и не была provider
failure. Cart POST/PUT/DELETE не выполнялись. Финальный успешный run: один login,
catalog page 1, catalog page 47, cart GET и user GET.

Санитизированный отчёт:
[`2026-09-18-read-only-unit-identity-observations.json`](../../evidence/aroma-provider/2026-09-18-read-only-unit-identity-observations.json).
Raw bodies, identifiers, credentials, cookies и PII не сохранялись.

Probe подтвердил непустую cart shape: line quantity `1`, `packing=null`,
`grind_id=null`; `products[].price=446` и вложенный `offer.price=579.8`
различаются. Это не устанавливает provider unit metadata, price basis или catalog fallback.
Catalog page 1/47 по-прежнему не содержат явных unit, price-basis,
min/max/step/fraction metadata; наблюдаются только `weight`, `is_grinded` и
`sold_by_piece=false`. Поэтому quantity admission/bounds и неподтверждённый
packing/grind mapping остаются fail-closed; подтверждённые `grindOptions` и
выбранный hash проходят отдельную identity-проверку. `unit=piece` задаётся
owner policy ниже.

Owner policy от 2026-09-18 задаёт для Aroma `defaultPacking=Aroma` и
`unit=piece`: `0.2 kg` означает одну фасовку, `quantity=2` — две фасовки, а
`offers.price` — цену одной фасовки/штуки без пересчёта на килограмм. Для помола
Catalog владелец может передать отдельный `sourceGrindKeyHash` (и отображаемый
`grindOptions`), который является optional выбором линии; 12 synthetic
`offerRef` для вариантов помола не создаются. Это owner policy, а не доказательство
provider unit/packing metadata.

`imageUrl` остаётся обязательным полем normalized offer, но допускает `null` при
отсутствии provider image. Такое значение сохраняется как provider fact; Catalog
и UI используют downstream placeholder, не синтезируя URL и не исключая offer.
Это bounded internal-v1 correction по issue #10 до подключения потребителей:
schema widening не требует новой API-версии; downstream Catalog/UI (#6) должны
принимать nullable generated contract. Отсутствие изображения не блокирует весь
catalog export.

## Binding не доказывает mutation semantics

Исследование не доказало, что `offerRef` однозначно определяет provider line:
line может различаться `grind_id`, упаковкой или иными variant attributes.
Provider wire не содержит unit metadata; owner policy от 2026-09-18 задаёт
`unit=piece` для валидных Aroma offers без пересчёта веса или цены. Не доказаны
currency, scale/basis, discounts/taxes, quantity bounds,
packing/grind policy и canonical image URL. Публичные HTML-страницы сайта (включая `/wholesale`) вернули KillBot
verification; frontend bundle и UI quantity limits не наблюдались. API каталога
на основном host отвечал успешно, как зафиксировано выше. Сопоставление
конкретного offer между API и отображением сайта выполнить не удалось. Binding является только immutable source
identity proof и не делает provider mutation разрешённой.

### Источники цены, количества и вариантов

Read-only исследование 2026-09-07: [первая страница API каталога](https://aromateacoffee.ru/api/v1/catalog/wholesale/products?page=1&per_page=2)
и последняя страница с `page=233&per_page=2` вернули 200, `total=466`.
В просмотренных offers поле `price` — JSON integer; полей currency, unit,
min/max/step и отдельного variant key не обнаружено. Это описание выборки,
не гарантия всей схемы. Маркеры ₽/руб найдены только в SEO `meta_description`;
они не устанавливают валюту, масштаб или базу `offers[].price`, скидки и налоги.
`params[]` содержит generic `param`, `param_value`, `value` и не доказывает
полноту identity для packing/grind.

[Публичная страница каталога](https://aromateacoffee.ru/wholesale) вернула
verification page. Поэтому ограничения UI и сравнение цены конкретного offer
между API и UI не подтверждены. Ограничения backend из UI не выводились.
Legacy `AromaCatalogLookupService.cs` (строки 443–469, 652, 872–905 в указанном
выше revision) содержит клиентскую интерпретацию веса и `is_grinded`;
она не используется как доказательство provider bounds или packing/grind.
Отсутствие provider metadata о currency, scale и price basis не блокирует
нормализацию по принятой owner policy: RUB × 100 за одну упаковку/штуку,
`unit=piece`, без пересчёта по весу. Нулевая цена сохраняется как `0`, но
`Available` заменяется локальным `Unavailable`; невалидная цена блокирует
нормализацию соответствующего offer. Неизвестные quantity bounds и
packing/grind сохраняют ограничения provider mutations. Исторические
наблюдения выше не отменяют последующие решения владельца в документе 28.

## Итоговая таблица исследования

| Вопрос                            | Подтверждённый факт                                                                                                                                                                                       | Доказательство                                                                                                     | Что осталось неизвестным                                                                                          | Влияние на adapter                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Currency и scale цены             | Provider wire не содержит currency/scale; интеграционная policy отдельно принимает `offers[].price` как RUB и точное умножение на 100 для одной упаковки/штуки                                            | API catalog и принятое решение [`28_AROMA_CATALOG_PRICING_POLICY.md`](28_AROMA_CATALOG_PRICING_POLICY.md)          | Provider-specific metadata не выводится из wire                                                                   | Применять принятое RUB×100 mapping; нулевую цену сохранять как `0`, переводить `Available` в локальное `Unavailable` и не считать это supplier stock claim        |
| Price basis                       | Price связан с конкретным offer; owner policy фиксирует его как цену одной упаковки/штуки без пересчёта на кг                                                                                             | Один product с четырьмя offer IDs, `weight` 200/1000 и `is_grinded` 0/1 плюс owner policy 2026-09-18               | Provider wire не раскрывает скидки, налоги и округление; provider price basis metadata отсутствует                | Хранить принятое package/piece basis; не считать цену за кг/упаковку формулой                                                                                     |
| Quantity unit, дробность и bounds | Provider wire не содержит unit metadata; owner policy 2026-09-18 задаёт `unit=piece`, `sold_by_piece=false` этому не препятствует; quantity `1` наблюдалась в cart                                        | Bounded safe reads 2026-09-18, transformed report и owner policy                                                   | Integer/decimal admission, min/max/step и серверные ограничения                                                   | Применять только `piece` policy; bounds/дробность без отдельного доказательства отклонять до journal/provider dispatch                                            |
| Offer/variant identity            | В выборке один product имеет отдельные offer IDs для веса 200/1000 и `is_grinded` 0/1                                                                                                                     | `data[].offers[].id/name/params[]` на page 47; IDs обезличены в отчёте наблюдений                                  | Гарантия для всех категорий и достаточность одного offer ID для mutation                                          | Считать offer key отдельной identity; сохранять variant params и требовать binding                                                                                |
| `packing` и `grind`               | Catalog показывает `is_grinded`; в непустой cart 2026-09-18 наблюдались `packing=null`, `grind_id=null`                                                                                                   | Live catalog shape и bounded cart GET 2026-09-18                                                                   | Допустимые non-null values, связь с offer/cart line и обязательность пары                                         | Не синтезировать provider mutation payload из имени offer или null observation                                                                                    |
| Cart item identity                | Непустая cart shape и отдельные line/offer identity fields наблюдались; raw IDs не сохранялись в transformed report                                                                                       | Bounded cart GET 2026-09-18; ранее сохранённые controlled captures                                                 | Correlation текущей line с Catalog binding, duplicate policy и общая uniqueness guarantee                         | Разрешать line только через fresh exact unique binding; один read не делает offerRef line identity                                                                |
| Session flow                      | На основном host login/user/cart/catalog работают без redirect; текущая реализация хранит зашифрованную session materialization и допускает bounded safe re-auth только до partial output/unsafe dispatch | Финальный последовательный probe 2026-09-08 и локальные session/journal проверки; cookie properties в разделе выше | Provider TTL/refresh/invalidation и обязательность companion cookie остаются неизвестными                         | После unsafe dispatch re-auth и повтор mutation запрещены; pre-dispatch safe re-auth ограничен одним bounded переходом и не является доказательством provider TTL |
| Pagination                        | Ответ `{data,links,meta}`; при `per_page=10` `total=466`, `last_page=47`; links ведут на `dev` host                                                                                                       | page 1/page 47 200; page 233 ранее дал 200 с пустым data при `last_page=47`                                        | Snapshot isolation и точная server policy для out-of-range pages                                                  | Строить same-origin pages самостоятельно и fail closed на неожиданный empty/out-of-range                                                                          |
| Mutation semantics                | Ограниченный сценарий 12 сентября подтвердил add, set quantity 1→2, duplicate POST 422, delete и repeated delete 404 для одного offer                                                                     | [`2026-09-12-cart-mutations`](../../evidence/aroma-provider/2026-09-12-cart-mutations/README.md)                   | Глобальные bounds/fractions, остальные packing/grind combinations, effect неоднозначных ответов и session refresh | Только Dispatched barrier + fresh read; наблюдённый сценарий не разрешает blind retry или обобщение на другие offers                                              |

### Решения, которые adapter уже может принять

1. Для safe catalog/session reads использовать только проверенный основной
   origin `https://aromateacoffee.ru`; absolute `links` на `dev` не следовать.
2. Декодировать catalog как полный JSON `{data,links,meta}`, валидировать
   page/meta и передавать в Catalog отдельные product/offer identities с
   `weight`/`is_grinded` как наблюденными параметрами; raw IDs хешировать по
   действующей схеме, не экспортировать их.
3. Принимать полную пустую корзину только когда `products` существует и равен
   `[]`; отсутствующий/частичный/невалидный `products` считать ошибкой, не
   пустым состоянием.
4. Ограничить session materialization Gateway, не логировать cookie values,
   не сохранять raw provider body и не выполнять redirect/re-auth после unsafe
   dispatch.

### Решения, которые всё ещё нельзя принять

- provider-supplied currency/scale fields отсутствуют; действует принятое policy mapping RUB×100 для цены одной упаковки/штуки, а zero-price handling задан локальной Platform policy;
- дробность и bounds quantity; `unit=piece` задаётся принятой owner policy, а не provider metadata;
- production-наполнение существующего binding и Gateway-local разрешение
  provider cart-line identity;
- mapping `packing`/`grind_id`, cart-line identity и политику duplicate lines;
- success/reject semantics, missing-line behavior и безопасную компенсацию;
- snapshot isolation, refresh/TTL cookies и UI limits.

### Что требует документации поставщика

Нужны официальные схемы и правила для currency/scale/basis/discounts/taxes,
quantity bounds, полного offer/packing/grind identity, cart item
identity, pagination consistency, origin policy и cookie security/TTL.

## Непроверенные мутации: controlled test plan

Только после отдельного явного разрешения и выделенного тестового аккаунта,
точного выбранного offer и заранее согласованных packing/grind параметров.
Отдельно требуется зафиксировать ожидаемую quantity и её документированный
bounds; значения `1` и `2` нельзя подставлять как доказанные bounds.

1. Выполнить fresh GET cart baseline и убедиться, что тело полное, snapshot
   однозначен, а выбранный offer/variant либо отсутствует для сценария add,
   либо имеет ровно один согласованный `cartItemId` для сценария update/remove.
2. Выбрать ровно одну заранее разрешённую операцию: POST add с точными
   `offer_id`, `quantity`, `packing`, `grind_id`; либо PUT/DELETE по свежему
   `cartItemId`. Не смешивать сценарии и не перебирать параметры.
3. Выполнить свежий GET read-back. При timeout, redirect, 429, CAPTCHA,
   partial/malformed response, неожиданной строке или неизвестном effect
   остановиться и передать состояние на ручную reconciliation; blind retry
   запрещён.
4. Восстановление допускается только после определения фактического состояния,
   отдельного разрешения на восстановительную операцию и выбора метода по
   фактическому provider contract. DELETE не считать гарантированной
   компенсацией; после неизвестного результата не выполнять blind retry.

Этот план не доказывает максимум, налоги, все варианты или semantics provider;
его можно запускать только для одной заранее согласованной controlled case.

## Доказательства для продолжения

Сохранены минимальные обезличенные ответы с датой, методом, путём, status,
content-type, признаком полного получения и происхождением в
[`evidence/aroma-provider/`](../../evidence/aroma-provider/): public/auth
catalog page samples и login. Непустая cart read 2026-09-18 сохранена только как
transformed field/type observations без raw body и identifiers. Controlled captures
2026-09-12 отдельно подтверждают ack/reject для выбранного offer и missing-line
повторный DELETE 404; это не устанавливает глобальную provider semantics или
допустимый range/scale quantity.
Cookie values, credentials и пользовательские данные в сохранённом отчёте не
включены. Подмена ID должна сохранять отношения между catalog offer/cart
offer/cart item; отчёт наблюдений явно отличается по происхождению от
synthetic test data и не заменяет provider wire-format capture.

Безопасные GET выше выполнены по запросу пользователя. Новые provider cart
mutations ради characterization без отдельного разрешения не выполняются.
Пробелы выше блокируют соответствующие зависимые части adapter, но не запрещают
независимую реализацию локальных гарантий после согласования их входов.

## Статус локальной приёмки binding на 2026-09-08

На этом ограниченном этапе подтверждён только immutable offer binding. Внутренний
`InternalApiV1` содержит `registerAromaOfferBinding`; Integration migration/store,
маршрут `catalog-activation-worker → api-internal → aroma-gateway`, caller/network/
secret scopes и зависимости активации #6/#16 присутствуют. Синтетические
`Completed` snapshots используются только disposable-проверкой и не являются
provider captures. Migration применялась только к disposable Integration DB;
рабочая БД не изменялась.

### Наблюдаемая verification текущего этапа

- `pnpm config:check` — exit 0: `platform config: OK (15 runtimes, development)`.
- `pnpm security:secrets` — exit 0: `security material: OK (development,
encrypted repository leaves and runtime scopes)`. Единственная repository
  copy import удалена после byte-identical сохранения; encrypted copy находится
  по `/home/yurgusev/.local/share/coffee-platform/imports/aroma-import.secrets.sops.yaml`
  (каталог `0700`, файл `0600`, SHA-256
  `d165bbbab388944a8c1a5a0f77309ff0b582895053652d140de8dff30c2cd4a2`).
- `pnpm authority:check` — exit 0: positive acceptance passed, 4 unittest
  passed. `pnpm contracts:check-generated`, `pnpm contracts:breaking`,
  `pnpm contracts:test`, `pnpm architecture:check`, `pnpm db:smoke`,
  `pnpm typecheck`, `pnpm lint` — exit 0.
- `COFFEE_DB_LIVE_PROOF=1 node --test tests/aroma/binding-http.test.mjs
tests/aroma/binding-live.test.mjs tests/compose/topology.test.mjs` — exit 0;
  binding-live не skipped. Проверены immutable replay, оба conflict paths,
  unknown/incomplete snapshot cases, grants, restart/lost-answer и обе реальные
  конкурентные directions. Race-failure был в harness: contender запускался до
  фактического захвата holder row lock; добавлен явный тот же `FOR UPDATE`
  barrier без изменения production timeout/lock semantics.
- `pnpm test` — два последовательных штатных прогона exit 0: каждый завершён
  без failures (live binding намеренно проверен отдельной командой выше, а не
  замаскирован skip). Попытка `COFFEE_DB_LIVE_PROOF=1 pnpm test` exit 1 из-за
  штатного guard двух lifecycle tests, запрещающего глобальные live-proof
  locator variables в unit suite; это не acceptance gate.
- `pnpm test:compose-smoke -- --aroma-binding-proof` — exit 0. Это отдельный
  локальный режим существующего harness: реальный Compose `api-internal` и
  `aroma-gateway`, native HTTPS/mTLS sockets, server CA/SAN и client
  certificate validation, настоящая API-internal delegation, Gateway claims,
  disposable Integration PostgreSQL и реальные migration/DB role. Набор
  проверок дал `200` для allowed/replay/restart replay, `409/409` для offer/source
  conflicts, TLS rejection для no/untrusted client cert, `401` для foreign
  identity, `403` для forged/expired/wrong claims, `400` для malformed JSON и
  ровно одну durable binding. Raw provider canary отсутствовал в HTTP response
  bodies, bounded logs и sanitized evidence. Gateway в этом режиме не имеет
  provider-egress connectivity; AROMA endpoint не вызывался.

### Полный Compose и прежние failures

- Full `pnpm test:compose-smoke -- --stub-secrets` не принят: после исправления
  Kafka stub wiring Kafka стал `healthy`, но полный запуск с `--keep` показал
  `api-internal` `running/exit 0/healthy`, `orders-service`
  `running/exit 0/unhealthy`, `/health/ready → 503`; также unhealthy были
  catalog/customer/pricing/aroma-gateway. На `coffee_postgres_data` в момент
  диагностики не было Postgres container, только app containers, тогда как
  `config/platform.yaml` требует `coffee_postgres:5432`. Это blocker
  topology/infrastructure smoke, а не доказательство отсутствующей Orders
  business logic; `/health/ready` безусловно успешным не делался.
- `--no-build` отдельно остановился на отсутствующем image tag
  `coffee-compose-smoke-360926-1b914da3-pricing-service:latest`; повторный
  build дошёл до реальной health диагностики выше. Все созданные ресурсы
  exact Compose project удалены; shared `coffee_postgres_data` сохранён.
- Прежний `orders-service unhealthy` теперь разделён на две причины. Подтверждён
  defect harness: для `--stub-secrets` Kafka refs получали строковый placeholder
  вместо сгенерированного Kafka credential; исправлено в существующем
  `compose-smoke`. Текущий full-stack blocker — отсутствующий PostgreSQL в
  topology smoke. Исторический `bootstrap-first: Query read timeout` в текущем
  bounded прогоне не воспроизведён; отдельная причинность для него не
  объявляется установленной. Наблюдаемый `expected ... to wait for export row
lock` устранён детерминированным DB barrier и после этого два live proof
  направления прошли.

### Границы и оставшаяся реализация #10

Этот результат не закрывает #10 и не разблокирует #6/#11 целиком.
В текущем коде уже реализованы explicit-source bounded NDJSON export с
snapshot/batch/content-hash lifecycle, HMAC source identity helper и durable
mutation journal с recovery после неопределённого COMMIT. Их локальные проверки
описаны в [core evidence](../../evidence/issue-10-core-regression-acceptance.md).
Они не являются готовой production provider integration.

В scope #10 остаются provider-backed source/decoder/normalization, production
HMAC key wiring и наполнение binding, session lifecycle, complete cart read и
set/remove adapters, четыре production операции Gateway/api-internal,
Gateway observability/readiness и обязательная полная приёмка. Для adapters
нужны подтверждённые currency/scale и provider-specific price metadata сверх
принятого package/piece basis, variant/packing/quantity bounds,
cart-line identity и mutation acknowledgement/missing-line semantics.
`providerSnapshotRef` требует определённого происхождения и гарантий по
внутреннему контракту; наличие именно такого поля в JSON AROMA не требуется.

Catalog staging/importer/activation и durable acknowledgement на стороне
Catalog, а также Orders Desired/Observed/convergence реализуются в зависимых
задачах и не являются дополнительным объёмом реализации #10. `Bound` означает
только durable связь `offerRef` с supplier/source hash и первым Completed
snapshot; это не доказательство cart-line или provider mutation readiness.

### Обновлённые provider evidence от 12 сентября

[Публичные captures](../../evidence/aroma-provider/2026-09-12/README.md) и
[авторизованные captures](../../evidence/aroma-provider/2026-09-12-authenticated/README.md)
сохраняют JSON shape с документированным обезличиванием ID. Это пригодные
образцы наблюдавшихся ответов, но не полная provider schema. Подтверждены login,
account probe, пустая корзина и отдельные страницы каталога. Это описание
ограничено указанными public/auth captures и не включает более поздние cart
evidence ниже. Публичные и
авторизованные цены выбранных страниц совпали; currency/scale/price basis этим
не установлены. В этой ранней выборке непустые строки, refresh и mutations не
проверялись; последующие controlled captures и read-only observations описаны
ниже и не переписывают происхождение этой выборки.

Development email/password исправлены в canonical encrypted inventory по
отдельному разрешению пользователя; runtime получает их исключительно через
config-bootstrap. Внешний import не является runtime fallback.

Будущее уточнение #10/#6/#16 (не публиковалось): `catalog-activation-worker`
в durable preparation transaction назначает/переиспользует `offerRef` и
сохраняет задание binding после того, как #6 получил completed snapshot.
После commit он вызывает Gateway; Gateway сохраняет immutable binding в своей
Integration owner boundary, а `catalog-activation-worker` сохраняет полученный
`Bound`/`firstSnapshotRef` как durable acknowledgement в Catalog owner DB/Outbox
до activation. Catalog activation ждёт acknowledgements всех required owners
перед активацией. Без durable ack нельзя отличить committed binding от
потерянного ответа, а частичная активация нарушит convergence/replay invariant.

## Подтверждение границ этого этапа

В локальном binding-этапе, к которому относится этот раздел, не выполнялись
обращения к сайту или API AROMA, login/refresh, provider mutations или cart
checks. Это историческая граница конкретного proof, а не утверждение о всей
последующей работе #10: controlled cart scenario и bounded read-only probe
описаны ниже. В binding-этапе также не выполнялись commit, push, PR/issues
publication, merge, deployment или provider-origin selection. Provider observations
выше и `evidence/aroma-provider/` относятся к отдельной работе и не являются
доказательством текущего binding proof. Runtime binding code, contracts и
canonical secrets inventory изменялись только в уже dirty рабочем дереве в
рамках локального этапа; внешний encrypted import не подключался к runtime.

## Подтверждённый ограниченный cart сценарий — 12 сентября 2026

По отдельному разрешению пользователя выполнены [проверка и очистка корзины](../../evidence/aroma-provider/2026-09-12-cart-mutations/README.md).
POST одного `C-200-26` с quantity=1 и packing=Aroma дал 200; PUT quantity=2 и
его запланированный повтор дали 200 и quantity=2. Повторный POST вернул 422
«Товар уже в корзине»; свежий GET подтвердил прежнюю строку quantity=2.
DELETE созданной строки дал 200, повторный DELETE — 404, оба последующих GET
пусты. Начальный и финальный JSON корзины равны. Всего 6 cart mutations,
10 GET и 2 login; второй login потребовался для cleanup после остановки первого
скрипта на 422. Отклонение от одного планового login явно записано в evidence.

Для выбранного offer cart line `price` изменился с 620 до 1240 при quantity 1→2,
`total_with_discount` — с 434 до 868, вес — с 200 до 400. Вложенный `offer.price`
оставался 852.6. Эти денежные поля не взаимозаменяемы; их currency/scale и
глобальные правила нормализации по-прежнему требуют подтверждения.

Этот этап заменяет историческое отсутствие любых mutation observations только
для перечисленного сценария. Он не доказывает глобальные bounds/fractional
quantity, остальные packing/grind combinations, full cart identity, auth refresh
или безопасность resend. Production adapters и wiring теперь существуют, но остаются fail-closed там,
где этот сценарий не доказал quantity bounds/packing/grind/session semantics;
полная готовность #10 не заявляется. Supplier order submission не выполнялся.
