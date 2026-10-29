# ADR-0034: G16 на существующей учётной записи AROMA

Статус: реализовано; отдельный G16 PASS на candidate `0dbe0a40685cbf348f0a63f8633a8db3a74a5467`.<br>
Дата: 2026-10-23.<br>
Основание: прямое поручение владельца использовать существующую учётную запись,
создать sandbox и разблокировать G16 в #13.

## Контекст

Владелец 12 сентября разрешил использовать действующую учётную запись для
тестовых запросов и сообщил, что тогда в ней никто не работал. Сохранённые
`evidence/aroma-provider/2026-09-12-authenticated/` и
`evidence/aroma-provider/2026-09-12-cart-mutations/` подтверждают login,
ограниченные изменения собственной тестовой строки и восстановление пустой
корзины. Эти результаты не доказывают текущее состояние аккаунта.

23 октября владелец повторно поручил использовать этот аккаунт для G16.
Отдельный vendor sandbox не предоставлен. Прежнее безусловное запрещение
production origin в G16 не позволяет выполнить новое поручение на существующем
`https://aromateacoffee.ru`.

## Решение

Sandbox здесь — временный изолированный локальный контур приложения с
собственными PostgreSQL-ресурсами и управляемым разрывом ответа. Upstream —
реальный AROMA и существующая учётная запись. Изоляция аккаунта у поставщика
и создание отдельной vendor-среды не заявляются.

Для G16 допускается только режим `controlled-live-existing-account`.
Versioned policy и подписанный approval связывают точные origin, account
fingerprint, candidate SHA, run-id, approver, один offerRef и maximum quantity.
`existingAccountException.authority=user-2026-10-23` обозначает это конкретное
поручение. Exception origin/fingerprint должны точно совпадать с policy и
фактически проверенным аккаунтом; wildcard и fallback запрещены. Это явное
исключение из прежнего production origin/account deny для указанной пары.
Остальные deny-list targets запрещены. Environment приложения `production`
запрещён без исключений.

Approval этого эксперимента подписывает одноразовый делегированный executor,
а не личный криптографический ключ владельца. Его Ed25519 private KeyObject
создаётся и используется только в памяти отдельного локального операторского
процесса; private key не записывается на диск, не передаётся runtime и исчезает
при завершении процесса. Public key входит в versioned policy candidate.
Подпись связывает уже выбранный свежий offerRef с ограниченным поручением
владельца; она не создаёт нового разрешения и не использует service keys.
До подписи допустимы только safe provider reads и локальная подготовка;
отсутствие approval прекращает сценарий с cleanup без мутаций.

Используются существующие canonical development refs `aroma.email/password`
через trusted `config-bootstrap` и Gateway-scoped materialization в tmpfs.
Копии credentials, второй encrypted inventory, legacy fallback и изменение
supplier-owned login/password не нужны и не разрешаются этим решением.

Provider profile не обещает неизменяемый account ID. Account fingerprint
определяется как HMAC-SHA256 проверенного authenticated email с существующим
Gateway `aroma.catalogIdentityKeyV1` и отдельным namespace
`coffee-platform:g16:account:v1`, origin и cart scope. Email сначала сравнивается
с canonical credential в памяти; пароль в MAC не участвует. Сохраняется только
`sha256:<hex>` MAC. Это ограниченное разрешение на закрытый keyed account
identifier для G16; открытые хэши email/password и значения credentials по
ADR-0017 по-прежнему запрещены. Ключ MAC и profile payload не попадают в evidence.

## Границы выполнения

- Начальная свежая полная корзина должна быть пустой; иначе остановка до мутации.
- Один offerRef из свежего реального каталога и mapping; количество не больше
  двух единиц Gateway, без помола и только с подтверждённой упаковкой.
- Выбор mapping из каталога — только candidate selection. Для текущего AROMA
  wire proof G16 выбирает только provider offer `445`: после fresh catalog export
  и activation Gateway owner делает exact raw-offer reverse lookup, а Catalog
  active/Available/whole-bean mapping обязан вернуть тот же canonical `offerRef`.
  Перед approval и повторно перед mutation grant Gateway binding проверяется с
  точными offer/supplier. Если binding не содержит packing/grind, допускается
  только отдельный проверенный wire proof для offer `445` и совпавшего account
  fingerprint: `packing=Aroma`, `grindId=null`, quantity `1`, успешная точная
  cleanup baseline. Proof и исходный receipt закреплены SHA-256 в G16; он не
  записывает факты в immutable source binding и не расширяет owner default.
  Явный конфликт binding, другой offer/account, отсутствующий или изменённый
  proof даёт `AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN`. Для остальных offers
  отсутствующие facts по-прежнему fail closed. Подписанный approval по-прежнему
  обязан точно называть fresh `offerRef`; cold Catalog DB может создать новый
  случайный ref для того же HMAC, поэтому старый approval не переносится между
  такими контекстами.
- Запрещены provider checkout, заказы, счета, оплата, профиль и изменение
  credentials. Отсутствует произвольный URL/method/body и blind retry.
- Orders сохраняет настоящие lease/fence/reservation и durable UnknownOutcome.
  Ответ теряется только после доказанного принятия мутации AROMA и Gateway ack.
  После настоящего перезапуска сначала выполняется свежий GET; старый
  operationRef не отправляется повторно.
- Восстановление меняет только собственную однозначно идентифицированную строку
  новым operationRef. Чужая строка или изменение означает STOP/FAIL; массовое
  очищение корзины и удаление чужих данных запрещены.
- PASS требует всех семи фаз G16 и финального полного fingerprint, равного
  baseline. При неполном восстановлении — disable дальнейших мутаций, FAIL и
  P0 defect; успешная подпись сама по себе не даёт PASS.
- Временные контейнеры, БД, private materialization и процессы удаляются после
  проверки. Существующие сервисы CoffeeOrderSystem не входят в этот контур.

## Доказательство и ограничения

Evidence указывает режим `controlled-live-existing-account`, реальный origin,
account MAC, SHA/run-id, порядок операций, durable факты и результаты cleanup.
Сырые cart-line/profile IDs, cookies и credentials не сохраняются. Единственный
публичный catalog offer `445` фиксируется в ограниченном packing proof по
отдельно разрешённому плану; другие provider IDs в evidence не добавляются. Потеря
Gateway→Orders ответа не выдаётся за provider timeout: Gateway уже Acknowledged,
а UnknownOutcome принадлежит Orders.

В текущем запуске успешная catalog phase сама по себе не является G16 PASS:
без первичных фактов о точной persisted binding запуск останавливается до
`APPROVAL_REQUIRED` с `AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN`. G16 остаётся
guarded/непринятым, пока эти факты не доказаны и полный фазовый сценарий не
завершится с соответствующим evidence.

Прямая доставка настоящих owner Outbox envelopes в production Inbox handler
внутри контура может проверять application effects, но не Kafka transport.
Такое ограничение фиксируется явно; broker transport проверяется своим gate.
Миграции локальных owner DB исполняются через trusted bootstrap admin с
`SET ROLE` в canonical NOLOGIN migrator; отдельный migrator login не заявляется.
Desired задаётся как контролируемый вход теста в отдельной Orders DB: атомарные
монотонные revisions, lines и work. Fixture не меняет Observed, Attempt,
Reservation, lease/fence или recovery state. После потери ответа Desired
остаётся прежним до завершения restart/reconciliation; пустое намерение для
восстановления публикуется только затем. Это не proof цепочки Confirm →
contribution → aggregate Desired и не повод добавлять продуктовый Cancel.
Результат этого отдельного G16 не заменяет общий G00–G19 и не закрывает #13.

### Первый импорт Catalog

Первоначальный G16 от 23 октября использовал явный `ANALYZE` disposable Catalog
через canonical migrator. Его immutable evidence сохраняет
`catalogStatisticsPrepared=true`, `coldDatabasePlannerProof=false`: прежний
owner SQL обработал 810 offers за 5017ms в финальной транзакции при бюджете
10000ms только после подготовки statistics.

По поручению владельца от 24 октября production activation переведена на
пакетные операции по проверенному поколению. Cold regression на 810 offers и
2085 identities запускается на новой БД без statistics, с canonical runtime
ролью и прежними DB-бюджетами. G16 использует этот же production путь без
дополнительного `ANALYZE` и migrator hook. `catalogStatisticsPrepared=false`;
отдельный cold regression не выдаётся за общий capacity proof или за повторный
live G16. Исторические failed runs и их hashes не переписываются.

Catalog pricing input в private HTTP harness вызывает настоящий `createCatalogOwner`
поверх `CatalogStore` через existing `catalog-service` pool с `coffee_catalog_api_ro`.
Owner проверяет snapshot freshness с canonical
`services.catalog-service.catalogSnapshotProof.maxAgeMs`; cart observation age
не подменяет этот бюджет. Ручное построение pricing DTO исключено.
Activation writer не имеет прав на API views. Scoped materialization включает
шесть runtime; canonical grants, roles и secret refs не меняются. При отказе
фазы до cleanup сохраняются только finite safe Attempt/state-count/phase facts;
неудачный refresh не выдаёт прошлые counts за текущее состояние.

Фактический итог: `evidence/launch/20261023T184429Z-0dbe0a4/README.md`.
Все семь фаз, durable recovery и точное восстановление пустой baseline PASS;
временный контур и approval material удалены. В обычном config после проверки
mutations выключены и verification policy null. Полный #13 остаётся blocked
по отдельным launch prerequisites; этот результат не является G00–G19 admission.
