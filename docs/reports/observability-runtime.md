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
