# Запуск наблюдаемости до приложений

Отчёт по [issue #223](https://github.com/YurGusev/CoffeeOrderPlatform/issues/223) и [PR #224](https://github.com/YurGusev/CoffeeOrderPlatform/pull/224). Вход — принятая поставка [#210](https://github.com/YurGusev/CoffeeOrderPlatform/issues/210); потребитель — [#13](https://github.com/YurGusev/CoffeeOrderPlatform/issues/13). Этот отчёт не является допуском полного запуска платформы.

## Поведение

Grafana, Loki, Prometheus, Tempo, Alloy и локальный alert-sink запускаются до бизнес-приложений одним Compose. При отсутствии owner runtimes Collector принимает аутентифицированные OTLP metrics и traces; filelog и logs pipeline не создаются. При появлении или пересоздании приложений команда lifecycle повторно обнаруживает фактические IDs и LogPath. Формальный discovery по умолчанию продолжает требовать все 15 ролей. Порядок подготовки и восстановления описан в [Operations](../operations/observability.md).

До остановки существующих контейнеров lifecycle сверяет G12 context, checkout, конфигурацию, ресурсы, собственные контейнеры, тома и сети. Для собственного запуска используются подготовленные локальные образы; автоматическое скачивание отключено. Четыре backend используют отдельные ограниченные постоянные volumes. При необходимости rebind может пересоздать Docker-запись собственного data-volume; backing-файл сохраняется.

## Подтверждённое

- CI [41160783310](https://github.com/YurGusev/CoffeeOrderPlatform/actions/runs/41160783310) — success: 1422 теста прошли, 79 пропущены, отказов нет. Это не formal launch admission.
- Узкие проверки generator и storage/lifecycle — соответственно 7/7 за 0,770 с и 15/15 за 1,059 с, без skips. Зависимости и `dist` этих запусков были symlink на другой checkout той же базовой ревизии; они не заменяют чистую сборку и CI.
- Конфигурация Alloy без log owners проверена закреплённым готовым образом: validation exit 0. Это отдельная проверка конфигурации, не доказательство доставки сигналов.
- Компонентный G12 для executable candidate `0b7a95b2d7ef210ce2547087aa51d472eae770f6`, run `20261031T033022Z-0b7a95b` — PASS за 1506,183 с, 22 image и 46 reports, cleanup failures отсутствуют. Raw scan содержит 2 HIGH, оба разрешены уже исправленными artifact-specific решениями; unresolved HIGH и CRITICAL — 0. SHA-256 result: `7c4950388229ce73bf75436dc28b21bb50570123b94fdef0c52d3e2297b3a47c`. Это не formal G12 admission.
- Реальный backend-first start того же candidate завершился exit 0 за 66,012 с без owner runtimes. Проверка пяти health endpoints вернула HTTP 200; запросы без bearer, с неверным bearer и анонимный доступ к Grafana получили HTTP 401. На backend обнаружены собственные синтетические OTLP metric и trace, native Loki marker, Grafana datasource proxy query и annotation.
- Снимок шести контейнеров до контролируемого восстановления показал policy `on-failure`, отдельную internal network без опубликованных host ports, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, ограниченные ресурсы и отсутствие Docker socket. Collector использует UID 0; alert-sink был running, но отдельного healthcheck у него нет. Это снимок конфигурации и состояния, а не доказательство безопасности под полной нагрузкой.

- Контролируемая потеря четырёх собственных loop attachments и трёх производных tmpfs-файлов завершилась; повторный guarded start вернул exit 0 за 40,007 с. Затем пять health endpoints снова вернули HTTP 200, все шесть container IDs изменились, identity четырёх backing-файлов сохранилась. Повторно найдены исходные markers Loki, Prometheus и Tempo, Grafana annotation и datasource proxy query; после проверки собственная annotation удалена. Это контролируемое восстановление, не перезагрузка ОС.

Санитизированные сводки: [запуск](../../evidence/observability/deployment-20261031/startup.json), [сигналы](../../evidence/observability/deployment-20261031/signals.json), [границы контейнеров](../../evidence/observability/deployment-20261031/security.json), [supply chain](../../evidence/observability/deployment-20261031/supply-chain.json), [хранение и восстановление](../../evidence/observability/deployment-20261031/storage.json). Каждая содержит SHA-256 исходного receipt; полные журналы и materialized конфигурации не публикуются.

Ранее холодная G12-попытка остановилась по timeout через 1818,322 с; следующая остановлена через 346,119 с из-за одновременного CI на том же сервере. Успешный запуск выполнен после сериализации работ. Эти отрицательные результаты не переименованы в успех.

## Ограничения

Пользовательский systemd unit подготовлен для того же G12 context и прошёл `systemd-analyze --user verify` с exit 0; Linger включён. Unit ещё не установлен и не включён, фактический запуск через него не выполнялся: активация предусмотрена после принятия release. Реальная перезагрузка ОС не выполнялась и не заявляется.

Native Loki marker подтверждает только работу Loki; в zero-owner режиме он не подтверждает чтение логов приложения через filelog. Alert-sink хранит события в tmpfs. Formal G14 и полный #13, работа под полной нагрузкой, HA и длительное наблюдение не выполнены в рамках этой проверки. Операторские source receipts хранятся отдельно; в репозиторий не копируются секреты, содержимое scoped конфигураций и полные журналы.

## Внешний PostgreSQL и реальные runtimes

Поставка [#222](https://github.com/YurGusev/CoffeeOrderPlatform/issues/222), [PR225](https://github.com/YurGusev/CoffeeOrderPlatform/pull/225) исправляет противоречие между обязательной isolation policy и старым observability fixture, создававшим PostgreSQL container. Launch-context path использует только принятый внешний PostgreSQL, пять derived verification DB и десять runtime DB roles. G13/G14 artifact namespaces разделены. Подтверждённый исходный attachment PostgreSQL сохраняется; временный удаляется только после acknowledged connect. Неизвестная остановка consumers запрещает DROP. Browser использует только отдельно согласованный OIDC-only child с exact parent/config/image binding.

Actual component проверен на immutable `cffe147d36caff3fd8b6a4cb1f106e61fe86ac46`, parent feature `e8426e1f8ba5749ff184c23c25dae5f2de771cc9`. Единственный committed delta — включение DB/Kafka isolation. Readonly launch context run `20261031T095545Z-cffe147` и G12 inventory сверены штатным helper; DB preparation подтверждена свежей read-only attestation, это не G08 PASS. Итоговая выборка: [runtime result](../../evidence/observability/runtime-20261031/result.json).

- Component G12 PASS за1532,185с:23targets/46reports/22images; raw HIGH2, оба artifact-specific fixed VEX, unresolved HIGH0/CRITICAL0. Предыдущий cold FAIL по1800с ceiling сохранён отдельно.
- `python3 /home/yurgusev/.cache/coffee-launch-delivery/run-runtime-matrix.py` — exit0, PASS за1522,196с по supervisor clock, без остановки по бюджету или диску. Время включает private backend setup/cleanup; это не чистое время одной функции matrix.
- Реальные14 Node и native nginx прошли exact G12 image IDs, версии/production content/readiness/метрики/logging. Каждый Node ответил live200, ready200, metrics200 и unknown404. OTLP families проверены по реальным owner roles.
- Native nginx:1→0→1, forMs300000, остановка359,180с, actual Grafana firing episode и resolution. Во время nginx fault проверялись14 healthy Node.
- Внешний PostgreSQL container не создавался; пять derived DB удалены, retained=[]; исходный PG attachment не отсоединялся, routePreserved=true. Graceful shutdown, matrix cleanup и backend cleanup PASS; cleanupErrors=[]. Минимум root free37386665984байт при обязательном20%floor.
- Feature CI [41187484839](https://github.com/YurGusev/CoffeeOrderPlatform/actions/runs/41187484839) — SUCCESS на `e8426e1`. Единый повтор точных шести attachment/cleanup, matrix receipt и browser admission сценариев:6/6,0skip,49,343с; raw SHA256 `928cc274de21eca8f1b8eff85890655390e22a41ea8c660dab962d824816518d`. Полный argv сохранён в runtime result и handoff.

Исправлена ошибка private diagnostics: добавленный оператором Compose `--wait` преждевременно завершал startup на раннем unhealthy; stock G14 использует запуск и отдельные HTTP health polls. До успешного proof оператор приведён к stock-порядку без изменения product timeouts/thresholds. Ранние сравнения файловых систем смешаны с этим фактором: NTFS единственной причиной не доказан.

Это завершает external-PostgreSQL/runtime-matrix scope #222, но не admission #13. Healthy200 не доказывает readiness503 при отказах зависимостей. Actual browser traces, full native SSE qualification, остальные фазы G14 и полный G00–G19 остаются отдельными обязательными работами. Подтверждённый NET-1 (Node26 --allow-net не per-host ACL) не скрывается: ADR0019/G07 требуют решения владельца и дальнейшей проверки. Raw logs/operator хранятся приватно; hashes и ограничения опубликованы, секреты не включены.
