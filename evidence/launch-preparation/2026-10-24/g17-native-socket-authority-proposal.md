# G17: private Unix socket для нативного verification PostgreSQL

Статус: одобрено владельцем 24 октября 2026; точное разрешение: «Разрешаю предложенный G17 Unix socket».

Нативные PostgreSQL 17.11 binaries из уже закреплённого официального образа
прошли отдельную проверку initdb/start/query/dump/restore/stop/cleanup без TCP.
Факты и hashes: [native-postgres-feasibility.json](native-postgres-feasibility.json).
Новых dependencies, образов, ключей и secret stores не требуется.

Текущая schema фиксирует `postgres.host: coffee_postgres`. G17 и trusted
bootstrap требуют точного совпадения фактического endpoint с committed
`config/platform.yaml`. Прежнее разрешение на пять derived DB names не меняло
endpoint. Подмена через env, overlay, DNS или ослабление проверки не предлагается.

Предлагается допустить в sole committed `postgres.host` короткий абсолютный путь
`/dev/shm/coffee-g17-<hex>` только для standalone G17: non-production,
`verification.databaseIsolation.enabled: true`, проверенный readonly run-context,
clean candidate SHA и точный config hash. Обычный endpoint остаётся
`coffee_postgres`. Каталог socket принадлежит оператору и имеет mode 0700;
PostgreSQL запускается без TCP и без контейнера, с обычными durability settings.

Оператор создаёт только собственный кластер, пять derived verification DB и
новые точные restore DB. Перед fixture writes, backup, restore и cleanup
проверяются server version/system identifier, DB ownership и run/SHA. Для
локального Unix socket используется только private-cluster local trust;
TCP запрещён. Существующие зашифрованные credentials остаются в trusted
bootstrap; plaintext dumps и private keys на диск не записываются. Кластер и
socket удаляются после сохранения ciphertext и безопасных evidence.

Изменение ограничено schema/semantic validation endpoint, теми же проверками
G17/bootstrap и их существующими тестами, документацией и private operator.
Production/legacy DB, системные службы, `/etc/hosts` и рабочий Docker PostgreSQL
не затрагиваются. Отрицательные проверки обязаны отклонять production,
выключенную DB isolation, произвольные пути, symlinks/чужой каталог и несовпадение
run/SHA/config/server identity.

Этот standalone proof проверяет encrypted restore и owner recovery. Он не
доказывает TCP authentication, connectivity всех Compose runtimes, полный G00,
G09/G13 или допуск #13 на одном SHA; native AVX/AES blocker G14 сохраняется.
