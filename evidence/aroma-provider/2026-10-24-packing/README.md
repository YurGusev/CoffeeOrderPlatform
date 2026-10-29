# Packing: новая read-only проверка AROMA

Fingerprint существующего аккаунта и wholesale подтверждены existing typed
login. Выполнены три отдельных ограниченных read-only probe: GET `/lk`,
повторное чтение только структуры script sources и один GET первой страницы
wholesale catalog (10 products). Cart/profile mutations — 0. Canonical defaults
false/null не менялись, scoped tmpfs удалён после каждого probe.

GET `/lk` дал 200, но title classification `verification-like`, а inline script
структура содержит `document.cookie`/`atob` и не дала продуктовых JS URL.
Первоначальный узкий matcher `verificationChallenge=false` не является
доказательством продуктовой страницы; более полная структура зафиксирована
в последнем receipt. Challenge не обходился. Raw HTML, authenticated inline
scripts, profile и cookies не сохранялись.

На первой странице API нет packing-полей. Это ограниченная выборка: ни полнота
всего каталога, ни поддержка значения `Aroma` для выбранного offer не доказаны.
Owner policy `Aroma`, историческое `packing=null` и название товара не заменяют
wire/source fact. G16 packing остаётся NOT_PROVEN, guard не ослаблен.

REA Evidence IDs в `conclusions.json` относятся к публичной verification page,
а не к коду product/frontend поставщика. Они не доказывают packing semantics.
Владелец разрешил read-only поиск фактов в БД работающей старой системы.
Учётные данные не запрашивались.


## Исторические факты из старой БД

По прямому указанию владельца выполнены только read-only запросы в
`coffeeorderdb`: `BEGIN READ ONLY`, statement timeout 5s, `ROLLBACK`.
Это отдельное исследование происхождения packing, а не launch DB target.
Legacy runtime-код, модели и данные пользователей в платформу не переносились.
SQL и безопасный receipt приложены; ProfileName, cart scope, аккаунты и исходные
JSON не выводились.

В 19 844 сохранённых строках CurrentLines (150 offer) и 155 строках
ObservedItems встречается `ExternalPacking=Aroma`. В 606 mappings это поле
NULL. Параметр каталога `weight` совпал с WeightGrams в 583 сопоставленных
вариантах 100/200/357/500/1000 г; packing и вес — разные размерности.

Данные устарели примерно на 29 дней, отдельного provenance нет. Поэтому они
не доказывают происхождение default и нынешний wire result. Найдено 23
кандидата espresso coffee по 1000 г с историческим Aroma в Current и Observed,
активным verified mapping без manual review. Первые десять provider offer IDs:
441, 443, 445, 447, 453, 473, 475, 479, 485, 487. Они предназначены для свежего
read-only сопоставления с действующим каталогом. Checkout lines/snapshots/
allocations пусты; успешный checkout по этим данным не доказан.


## Свежий ограниченный lookup

Один typed login подтвердил прежний account fingerprint и wholesale. Прочитаны
десять страниц по десять products. Найдены provider offer IDs 445, 447, 473, 475,
479; у 445 и 473 подтверждены espresso category, weight1000 и is_grinded=0.
Остальные пять исторических ID не найдены в пределах выборки, это не доказательство
их отсутствия во всём каталоге. Во всех пяти найденных offer packing-field
отсутствует. Cart/profile mutations0, scoped tmpfs удалён.

Astra закрыл PACKING-CATALOG-001/002 после исправления merge cookie updates и
unknown is_grinded. Приложен `fresh-catalog-offers-receipt.json`.

Кодовая сверка установила более узкую причину G16: текущий catalog normalizer
не передаёт packing/grind для whole-bean, immutable source binding сохраняет
absence. Guard требует явных packing=Aroma/grind=null из этого binding. Reader
наблюдает cart packing отдельно и не изменяет catalog source identity. Нельзя
заполнять этот пропуск default или исторической DB записью. Отдельный bounded
protocol probe готовится только к согласованию; unsafe call ещё не выполнялся.


## Разрешённый разовый protocol probe — 24 октября, 11:38 UTC

По отдельному разрешению владельца выполнены один POST offer445 quantity1,
packing Aroma, без помола и один DELETE только созданной строки. Account HMAC
совпал; полный начальный GET был пуст. Два последующих GET подтвердили
одинаковую единственную строку offer445/quantity1/grind null с **packing=Aroma**.
Исключение для несовпавшей упаковки не понадобилось. Последний GET подтвердил
удаление и исходный пустой baseline. Один login, четыре logical safe reads
(верхняя граница physical attempts8), POST1, DELETE1. Scoped tmpfs удалён.

Raw/typed cart fingerprint до и после одинаков:
`70c9b239664dfa645ca8533bf66ad9a96fe3362ad94a1571a2cb94e6be20d57f`.
Это fingerprint полного typed provider cart, не алгоритм canonical G16 vector.

Первый setup остановился до login/GET/POST/DELETE из-за собственного env-флага
оператора в строгом bootstrap allowlist. Квитанция и marker этой ошибки сохранены.
После исправления только env boundary, повторных tester/Astra и подтверждения
нулевого provider budget подготовлена новая операция. Оба unsafe budgets теперь
использованы; marker успешного probe сохранён, повтор запрещён.

Приложены authorization, sanitized receipts, consumed marker и
`packing-wire-facts.json`. Это первичный packing-факт только для445 и этого
аккаунта; не глобальная семантика packing и не завершённый G16. Immutable
catalog binding не изменяется. G16 guard получает отдельный pinned wire proof
только для exact offer445/account; явные противоречия, другой offer/account и
изменённые evidence bytes отклоняются. Это изменение проверяется отдельно и
само по себе не является повторным полным G16 PASS.
