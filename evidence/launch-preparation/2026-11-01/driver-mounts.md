# Подключение файлов драйвера realtime qualification

Standalone G12 для Source `883c207d2b9ab60d0b8059293dc5229232354662` завершился PASS за 1696,201 с с 46 отчётами. Последующая qualification `i12-410581156d89479b` завершилась FAIL до начала нагрузки: `durationMs=0`, Docker exit 125. Все четыре фактически запущенных native image ID совпали с соответствующими G12; дополнительный retag или исключение проверки не применялось. Результат qualification не является допуском.

Причина отказа: readonly каталог подключался к `/fixture`, после чего runtime пытался создать внутри него точки монтирования отсутствующих `database-ownership.json` и `launch-context.json`. Первая операция завершилась `read-only file system`; вторая имела ту же структуру. [Документация Docker](https://docs.docker.com/engine/storage/bind-mounts/) описывает перекрытие содержимого подключаемым каталогом, а [код runc](https://github.com/opencontainers/runc/blob/main/libcontainer/rootfs_linux.go) — создание точки монтирования.

Исправление только для драйвера переносит оба readonly файла в `/run/coffee-launch/database-ownership.json` и `/run/coffee-launch/context.json`. Каталог `/fixture` остаётся readonly. Проверки точных источников, хешей конфигурации и ownership, а также четырёх полей child identity сохранены. Остальные роли и настройки защиты не менялись.

Проверки относятся к parent Source 883 с двумя локальными незакоммиченными файлами, а не к будущему candidate SHA:

- `tests/realtime/soak.test.mjs`: SHA-256 `5005add43e6ea251ca6342e5bed32f23067ddd5db9cf14e3e5dab1a3d62a98be`.
- `tests/realtime/fixtures/harness.test.mjs`: SHA-256 `b825ae27a33b619c6ef43b7e29355b0a026d4f89347156ec1cb68c8e53003719`.
- Узкий тест существующего launch: PASS 1/1, 0 пропусков; проверены пять mount, отсутствие вложенных путей и отказ при подмене ownership, конфигурации или identity. SHA-256 лога: `c77676b627ca058b503cf5b3e2426c35ebcf58edd1fb6e763907e2ba2d06feaf`.
- Реальный Docker-пробник с синтетическими публичными данными: PASS. Фактически проверены пять mount, uid 1000, readonly root и четыре readonly пути, `cap-drop ALL`, отсутствие сети, три SHA-256, четыре поля identity и запись только в `/results`. Собственный контейнер и временные файлы удалены, исходный набор образов сохранён. SHA-256 приватного результата: `10fa5f30ff2a5e6773b35186af23a21fb2f4ef9b8c4f232395d046813968da94`; лога: `a2dfd73f000895539dc59bbf96e0cef5316a3c533669be8e2a135ac7bbd2286b`.

Исходные отрицательные результат и cleanup qualification сохранены: первоначальный `cleanupVerified=false`. Отдельной ручной проверкой подтверждено отсутствие восьми контейнеров и сети и удаление private material; Git child сохранён. Два image ID и их refs оставлены, поскольку исходное владение ими не установлено. SHA-256 приватной записи ручной проверки: `385fed0e70a2a1acb3e75d7e85b003518d62cfe2972175941f8dd69ad892a0bb`.

Пробник не является SSE qualification или полным runtime proof. Для нового замороженного Source необходимы собственные CI, G12, обязательная полная SSE qualification и G00–G19; лимиты G14 1800 с, основного запуска 7200 с и qualification 2700 с не меняются. Старый G12 PASS на новый SHA не переносится.
