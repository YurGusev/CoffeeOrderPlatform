# ADR-0041: Сетевые границы локального сервера

Decision ID: `ADR-COP-LOCAL-NETWORK-001`

Status: Accepted

Date: `2026-10-31`

Supersedes: ADR-0019 только в части гарантии Node Permission Model для отдельных
исходящих host:port внутри общей Docker network.

## Контекст

Владелец выбрал уточнение фактической гарантии локального сервера без нового
сетевого контроллера. Diagnostic TCP probe имеет SHA-256
`478eeebb2d0205987a3a2f581df15d1e01aebe481e475ecea6a79c5270f8da7d`.
Он подтверждает сетевую достижимость, но не обход mTLS, авторизации или DB roles.

Закреплённый Node 26.8.1 принимает `--allow-net` как глобальное разрешение
сетевых операций, а не фильтр отдельных имён и портов. Node Permission Model
ограничивает случайный доступ доверенного кода, но не является sandbox для
вредоносного кода. Контейнеры общей Docker bridge network могут устанавливать
между собой TCP-соединения. Источники: [Node CLI 26.8.1](https://nodejs.org/download/release/v26.8.1/docs/api/cli.html#--allow-net),
[Node permissions](https://nodejs.org/download/release/v26.8.1/docs/api/permissions.html),
[Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/) и
[предложение Node по host:port](https://github.com/nodejs/node/issues/67115).

## Решение

- Node launcher применяет глобальный `--allow-net`, когда runtime требуется
  сеть. Ограничения filesystem, addons, child process, workers и FFI сохраняются.
- `allowNet`, `allowedHostPorts`, `allowedExternalEgress` и `denyAssertions` —
  инвентарь ожидаемых связей и намерений policy. Их согласованность не доказывает
  отказ TCP или DNS/IP для неуказанного адреса. Поле `nodeNetworkEnforcement`
  фиксирует этот факт как `global-only`; это не переключаемая настройка.
- `hostPortPolicy` описывает только опубликованные порты хоста. Compose network
  attachments и публикации портов сохраняются; общая network не является
  разрешением на выполнение операции. Доступ к private API определяется mTLS
  и caller/operation authorization, доступ к данным — PostgreSQL roles.
- Provider-клиент Gateway сохраняет настроенный HTTPS origin и запрет redirect
  на другой host. Это ограничение пути приложения, а не firewall произвольных
  сокетов процесса. Provider credentials и роли остаются scoped.
- Гейт `config_security` проверяет заявленные pins, конфигурацию и секреты согласно своей команде.
  Его PASS не является доказательством per-host TCP isolation; фактические
  сетевые и authorization проверки требуют отдельного evidence.

Node/npm/Corepack/pnpm pins, 15 runtime, trust roots, owners и canonical roots
не меняются. ADR-0030 сохраняет требования будущей Wave 2 к сетевым ACL;
они не считаются реализованными этим решением для локального запуска.

## Откат

Восстановить гарантию per-host TCP можно только отдельным решением с доказанным
механизмом enforcement и соответствующими negative probes. Возврат синтаксиса
`--allow-net=host:port` без такого механизма гарантию не восстанавливает.
