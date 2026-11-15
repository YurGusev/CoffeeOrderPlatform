# Постоянная установка наблюдаемости

31 октября 2026 года установлен и включён `coffee-observability.service`:
Grafana, Loki, Prometheus, Tempo, Alloy Collector и alert-sink работают в одном
Compose project `coffee-platform`. Пять healthchecks проходят; sink работает
без healthcheck по принятой конфигурации. Host ports отсутствуют, сеть internal.

Исполняется immutable release `0b7a95b2d7ef210ce2547087aa51d472eae770f6`
из `~/.local/share/coffee-platform/observability/releases/`. Он входит в принятый
merge #223 `de217f27de1973ef149be2a218b9c2cb45f070e9`. Владелец принял PR #224;
после устранения отдельного Tasty fixture defect #226 CI41170450421 на
`develop` `f412aaa4657a435d2bb6f6d3c45ee162dbf8ec9a` прошёл. Исходный отказ
CI41168287100 сохранён и не считается PASS.

Unit имеет `Type=oneshot`, `RemainAfterExit=yes`, состояние `active (exited)`,
`enabled`, `Result=success`, `ExecMainStatus=0`, `NRestarts=0`. Это управляющий
lifecycle: сами контейнеры продолжают работать. `Linger=yes` проверен. Unit
передаёт только закреплённый Node locator и путь к persistent G12 metadata;
secrets материализует trusted bootstrap в scoped tmpfs. Установка выполнена
эксклюзивным созданием unit без перезаписи существующего файла.

Фактические команды:

- `systemctl --user daemon-reload` — exit0,0.767s;
- `systemctl --user enable --now coffee-observability.service` — exit0,51.679s;
- `systemctl --user show coffee-observability.service` с выбранными status
  properties — exit0,0.017s;
- pinned Node с приватным runtime operator: `record` — exit0,7.840s,
  `verify` — exit0,5.127s.

Перед запуском unit были записаны собственные OTLP metric/trace, Loki marker
и Grafana annotation. После запуска все шесть container IDs новые, четыре
backing identity прежние; старые metric/log/trace и annotation прочитаны через
backends и Grafana datasource proxy. Собственная annotation удалена. Missing
и invalid bearer дают401, anonymous Grafana даёт401. Источники приложения,
Kafka и PostgreSQL ради этого запуска не создавались.

[Санитизированный receipt](../../evidence/observability/installation-20261031/service.json)
содержит hashes и scopes. Приватные оригиналы и оператор находятся в
`~/.cache/coffee-launch-delivery/normal-installation/`; исходный operator
отличается только output directory, его прежние evidence не перезаписаны.
Проверка привязана к точному component G12
`20261031T033022Z-0b7a95b`:22images/46reports, raw HIGH2, fixed2,
unresolved HIGH0 и CRITICAL0. Это не формальный G12 запуска #13.

Реальная перезагрузка сервера и restart Docker daemon не выполнялись.
Полный G14, SLO/capacity/HA и приложение через browser ingress не доказаны.
Постоянный вход оператора не настраивался; временный OIDC разрешён только
для согласованных DEV-проверок. Этот отчёт не меняет решение #13
«НЕ ДОПУСТИТЬ» и не заменяет его полный G00–G19.
