# Разовый packing probe offer 445: план для согласования

Статус: код и fake-проверки приняты tester/Astra; разрешения на provider mutation
и исключение packing guard ещё нет. Live-режим не запускался.

Оператор: `/home/yurgusev/.cache/coffee-issue13/packing-20261024/packing-probe-once.mjs`.
SHA-256: `70949e6ababafe8cb8efa0c721662eeaff2a72d6e82d2963cdd1e3594ce1cf31`.

## Граница

Только существующий разрешённый аккаунт с точным HMAC fingerprint и wholesale.
Только provider offer `445`: свежий каталог подтвердил espresso, 1000 г,
`is_grinded=0`; старая DB хранит для него packing Aroma. Свежего packing-факта
ещё нет. Это отдельная проверка протокола, не PASS G16 и не изменение
immutable catalog binding или глобального guard.

## Действия

1. До доступа к провайдеру создать одноразовый marker и operation IDs, expiry
   не более двух часов; повторное использование marker запрещено.
2. Один typed login; проверить аккаунт, затем полный GET корзины. Продолжать
   только при пустом baseline.
3. Не более одного POST AddLine: offer445, quantity1, packing Aroma, без помола.
   Не повторять POST при потерянном ответе.
4. Полный GET должен показать только единственную созданную строку: offer445,
   quantity1, grind null. Сохранить только literal packing и безопасные hashes;
   provider line ID остаётся в RAM.
5. Ещё один полный GET непосредственно перед удалением должен подтвердить ту
   же полную корзину и тот же line ID. Не более одного DELETE этой строки.
6. После любого DELETE, включая HTTP200, четвёртый GET должен подтвердить
   пустую корзину с fingerprint исходного baseline. DELETE не повторяется.

Максимум один POST и один DELETE; максимум четыре logical GET и восемь
physical safe GET attempts по штатному bounded retry typed client. Ровно один
login без safe re-auth. При неоднозначном POST cleanup разрешён только после
двух совпавших GET той же единственной строки. Любые чужие строки, другой offer,
количество, grind или изменение полной корзины прекращают удаление.

## Запрашиваемое узкое исключение

Разрешить этот один POST при отсутствии packing в каталоге и один DELETE только
точной созданной строки, даже если поставщик вернул packing null или другое
значение. Перед DELETE остаются все проверки аккаунта, empty baseline,
единственной строки, offer445, quantity1, grind null и двух одинаковых полных
GET. Это не разрешение ослаблять обычный G16 guard или менять источник каталога.

## Проверка и ограничения

Tester: node --check и --self-test PASS на указанном SHA, реальных provider calls
и чтений секретов0. Fake cases: нормальный поток, потерянные POST/DELETE,
DELETE200 без эффекта, чужая корзина, expiry до запросов, embedded/escaped/short
secret canaries, SIGTERM без последующих запросов и с удалением fake tmpfs.
Astra закрыл PACKING-PROBE-001/002/003; новых существенных замечаний нет.

Секреты только в scoped tmpfs/RAM, receipt проходит substring scan до записи;
raw bodies, cookie, профиль и line ID не сохраняются. При stop/expiry новые
запросы запрещены; при неизвестном исходе DELETE или изменённой корзине может
потребоваться отдельное восстановление. Автоматический повтор unsafe запрещён.
После выполнения удалить только scoped materialization и приватный оператор;
сохранить sanitized receipt и once-marker, не допускающий повтор.
