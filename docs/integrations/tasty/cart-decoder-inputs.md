# Tasty cart: исследовательские входы для decoder

Это частичное исследование для #188, не реализация decoder, не принятый handoff и не основание отметить issue готовым. [Обезличенная проекция](../../../evidence/tasty/cart-decoder-inputs/2026-10-28-observation.json) хранит только выбранные факты и типы, без provider IDs, raw bodies, credentials, account ID и значений адреса.

## Что наблюдалось

28.10.2026 в отдельном read-only цикле: один login `200` и три GET `200`; mutation, logout, refresh и дополнительный profile-запрос не выполнялись. `GET /api/v1/catalog/cart` вернул `200`, поток ответа полностью прочитан (2972 bytes): `data` — массив с нулём элементов, `meta` — объект, `price` равен 0. Явных ключей pagination в корне и `meta` в этом ответе не наблюдалось. `last_order_address` имеет тип object; его значения исключены.

Во втором read-only цикле в 2026-10-28T11:05:49.184Z получены один login `200` и один GET каталога `200` (всего за оба цикла два login и четыре GET). В нём найден один кандидат: «Батч-Брю», `bean_coffee`, вес 250 в числовом поле и 250 г в названии, package «Tasty Coffee» есть в списке, вариантов помола у bean нет. Это данные каталога, не состояние корзины; cart GET первого цикла старше.

Полная передача тела не доказывает семантическую полноту физической корзины или отсутствие неизвестных скрытых строк. Отсутствие pagination keys в одном ответе не доказывает универсальный контракт. Пустой `data` сам по себе не доказывает владение или безопасность очистки, не подтверждает fresh physical completeness и не разрешает `InSync`.

Исторический `http-evidence.json`, selector `schema.cartFields`, содержит типы полей наблюдавшихся строк; `developer-fixtures.json`, `cartTen.data[*]`, содержит только выбранные `id`, `offer_id`, `quantity`, `grinding_id`, `package_id`, `is_promocode`, `item_data`. Это не сохранённый raw nonempty body. На пустом ответе типы полей строк не наблюдаются. Полная универсальная schema заполненной корзины остаётся **NOT_PROVEN**; совместное присутствие guard fields наблюдалось в одном контролируемом примере ниже; отсутствие флага не превращать в `false`. Неизвестная специальная или неоднозначная строка должна в будущей реализации закрывать безопасное чтение, а не считаться обычной строкой или пустой корзиной.

## Статические подсказки, не wire contract

- `ByRS4atM.js`, SHA-256 `d5ab25fb2736726be5ef45d15d6cd673b12a82337dc618be6623452d459da7e6`, bytes 2700–3220: UI использует fallback `data ?? []`, `meta ?? {}`, optional order и `is_promocode`.
- `CO73dRp7.js`, SHA-256 `d0be463256b2a803d728fd8617a739b4a3b93991255c25e0c1600fa4ee4f83cb`, bytes 12600–16650: UI использует `item_data`, `product` и `isGift`. Wire field `is_gift` известен из исторических типов `schema.cartFields`.

Поведение UI не доказывает требования полей или семантику сервера. JS не копируется в репозиторий.

## Контролируемая обычная строка — OBSERVED_BASELINE_RESTORED

Пользователь отдельно разрешил ровно одно добавление и одно удаление. В третьем цикле 28.10.2026 11:11:12.918–11:11:18.110 UTC выполнены один login, пять GET, один cart POST и один DELETE собственной строки; все ответы `200`, dispatches: add=1, delete=1. За три цикла суммарно: три login, девять GET, одно добавление и одно удаление. Эти наблюдения относятся только к конкретному опыту и не разрешают новые записи.

Выбранная обычная строка «Батч-Брю», bean 250 г, package «Tasty Coffee», quantity 1: `id`, `offer_id`, `package_id` числовые и представлены приватными aliases, `grinding_id: null`; `is_gift: false`, `is_promocode: false`, `item_data: null`, `active: true`, `is_blocked: false` наблюдались совместно в этой строке. Fresh GET после добавления дал одну строку; после адресного удаления собственного текущего row locator — ноль в `data`. Полное сравнение тел baseline и результата после удаления в памяти дало равенство; их сообщённые SHA-256 оригинальных тел также совпали. Значения `last_order_address`, оригинальные тела и credentials не сохранены. Сравнение конкретных ответов не доказывает полноту будущей физической корзины.

Для будущего локального контракта предлагается узкий strict decoder только для наблюдавшегося пустого envelope и обычной bean-строки: требовать присутствия и проверять типы `id`, `offer_id`, `quantity`, `package_id`, `grinding_id` и всех перечисленных guard fields; отсутствующие flags — отказ, а не `false`. Это кандидат, не принятый ADR и не готовая реализация. Ground и другие package варианты имеют исторические частичные источники #182, но не доказывают полный raw body или совместное наличие всех guard fields. Другие варианты, gift/promocode, скрытые строки, CAS, network loss и recovery не доказаны; неизвестное или неоднозначное состояние должно закрывать обработку, без вывода `InSync`.

## Происхождение и границы проверки

Свежая проекция создана из безопасного локального исследования `/dev/shm/coffee-tasty-input-research-ULD7Fl/observation.json`, SHA-256 `841ef16cd06b7eb9f572035ff504e281a799f5b8df42e223dfb7e1e34546c435`: selectors `authorization.loginStatus/tokenRetained`, `receipts` для login и GET cart, `cart.envelopeFieldTypes/dataCount/rowFieldTypes/metaFieldTypes/topLevelPaginationKeys/metaPaginationKeys/numericMeta.price`. Из содержащихся там каталожных данных ничего не перенесено. Этот временный источник может исчезнуть; hash производной проекции отдельно: `b9b9d56b23e47aa25b621148aab41dc19169c19c573228a540ca0bc875b2f906`.

Второй источник: `/dev/shm/coffee-tasty-input-research-ZI05sn/numeric-target-observation.json`, SHA-256 `b3fe0bcc440bf9ae7488e918cd731d8b22f4fe37566f07da2bac61ff7a73fc29`, selectors `observedAt`, `authorization.loginStatus`, `receipts` для GET каталога и `target.candidates[0]` для названий, типа, веса, packages и числа вариантов помола. Цены и другие данные каталога не перенесены.

Третий источник: `/dev/shm/coffee-tasty-input-research-g0Qz5O/controlled-row-observation.json`, SHA-256 `706d409fc176e2c5c2db6f52949053bfb0330d0dcf07c32042cf8863986c63d4`: selectors `startedAt`, `completedAt`, `dispatches`, `receipts`, `baseline`, `filled.envelopeFieldTypes/rowFieldTypes/selectedRow/meta` и `restored.fullInMemoryBaselineComparisonEqual`. Сохранены только выбранные типы и значения, не весь schema inventory; hash оригинального тела в receipts отделён от hash производной проекции.

Сообщённый SHA-256 оригинального тела свежего cart GET — `09771410c3bb2caafd4a91b4e165477557e6f1dc9a18f4dc6c956d3f9fe3e4fe`. Само тело не сохранено; повторно сверить его hash по этому supplement нельзя. Это не hash локальной проекции или исторических HTTP evidence.

Исторические источники относительно корня Obsidian Vault, 25.10.2026:

- `Вложения/CoffeeOrderPlatform/Tasty/2026-10-25/http-evidence.json`, `schema.cartFields`: SHA-256 `4b9c132523826de7528adef56fe98fe9fd1d1c3a468be07f06dddeac341eb9ce`.
- `Вложения/CoffeeOrderPlatform/Tasty/2026-10-25/developer-fixtures.json`, `cartTen.data[*]` и только перечисленные выше поля: SHA-256 `9841fe68dd3db866344d7dd6a5e97d676854a2a28f191d7fbfd5dcbadbb620db`.

Хеши источников относятся к этим сохранённым файлам, а не к оригинальным полным ответам. Генерация этого supplement из трёх сохранённых обезличенных проекций не выполняла дополнительных сетевых запросов.
