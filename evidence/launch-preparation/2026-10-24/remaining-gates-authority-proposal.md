# Предложение по отсутствующей authority оставшихся gates #13

Статус: все три точных предложения явно разрешены владельцем 2026-10-24.
Ответы: «Разрешаю предложенный G12», «Разрешаю предложенный G17»,
«Разрешаю точный supplement». Разрешение означает authority реализации;
фактический PASS соответствующих gates ещё должен быть доказан.
Ни один пункт ниже не снимает обязательный PASS G00–G19 на одном clean SHA.
Исходный issue запрещает новые dependencies/pins и изменение порогов; G17
расширяет доверенную операцию с ключом. Поэтому эти решения не подменяются
техническим выбором исполнителя.

## G12: один закреплённый scanner

Предлагается Trivy `0.76.1`, официальный image:

```text
ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c
```

Read-only HEAD OCI manifest подтвердил digest; image не загружался и не
запускался. Первичные источники:
[release](https://github.com/aquasecurity/trivy/releases/tag/v0.76.1),
[официальный registry](https://github.com/aquasecurity/trivy/pkgs/container/trivy),
[SBOM](https://trivy.dev/docs/latest/guide/supply-chain/sbom/),
[DB](https://trivy.dev/docs/latest/guide/configuration/db/).

Включить pin только в canonical toolchain registry с его schema/checker.
Runtime dependencies не меняются. Scanner получает readonly lockfile/manifests
или `docker image save` одного exact final image ID, без Docker socket, scoped
secrets, private identities и всего рабочего каталога. Для lockfile включить
dev dependencies; для lockfile и каждого final image выпустить CycloneDX и
JSON findings. Каждый HIGH/CRITICAL означает FAIL; ignore-unfixed, VEX и ручные
исключения не используются. Это консервативнее проверки exploitable findings.

Несекретные budgets/egress/freshness хранятся в sole `platform.yaml` verification
policy: один scanner за раз, CPU2, memory2048 MiB, parallel1, минимум20 GiB
свободного места перед image export, DB не старше24 часов. Только официальные
GHCR vulnerability DB registries, свежесть/digests записываются в evidence.
Временные tar/cache удаляются после сканирования; SBOM/findings/DB metadata и
checksums остаются в run evidence. Недоступная или устаревшая DB даёт FAIL.

Buildx provenance `mode=min` и metadata-file привязываются к exact source/tree,
config/BOM и final image IDs. Classic local image store может отбросить attached
attestation: наличие metadata само по себе не доказывает provenance, это нужно
проверить до PASS. Если требуемая связь не доказана, G12 остаётся FAIL.
Это не разрешение push образов, публикации или deployment.

## G17: существующий age только в trusted bootstrap

Переиспользовать уже закреплённый `age1.3.2`, public recipient set из `.sops.yaml`
и документированный основной/recovery age locator из `LOCAL_PLATFORM.md`.
Новый private key, secret store и runtime secret scope не добавляются.

Разрешить отдельную bootstrap-only операцию: `pg_dump` пяти verification DB
подаётся непосредственно в age encryption; ciphertext хранится только в
`evidence/launch/<run-id>/gates/G17_BACKUP_RESTORE/artifacts/`. При restore trusted
bootstrap расшифровывает поток прямо в `pg_restore` новой exact restore DB.
Plaintext dump никогда не пишется на диск/в logs и не передаётся runtime.
Целевые DB и сервер предварительно проверяются по run/SHA/owner/server identity;
legacy/production DB и существующие restore targets отклоняются.

Ciphertext, его checksum/recipient metadata, версии/schema/count/invariant hashes
сохраняются как immutable evidence. Private materialization, subprocesses и
только собственные restore DB удаляются после проверки. При partial failure
evidence сохраняется, cleanup проверяется отдельно; исходные DB не изменяются.
Owner workers доказывают completed/unfinished/UnknownOutcome recovery по
существующим production handlers; dump/restore без этого не даёт PASS.

Это расширяет назначение trusted age identity с SOPS bundle на verification
backup. Само наличие ключа и pin такого разрешения не означало.

## G00: корректирующий handoff supplement

Read-only аудит установил:

- #2/#19: legacy shape, все11 output hashes каждого совпадают с accepted merge;
- #3: legacy outputs содержат paths/roles/topology без исторических hash claims;
- #162:19 output hashes совпадают, часть inputs не содержит explicit merge field;
- #10: из34 currentOutputs16 совпадают, **18 не совпадают** ни с accepted merge,
  ни с PR head. Точный аудит:
  [issue-10-accepted-handoff-audit.json](issue-10-accepted-handoff-audit.json);
- #14: handoff отсутствует в accepted merge и текущем дереве. #19 ссылается на
  принятые design/authority paths #14, и эти paths существуют.

Предлагается отдельный явно принятый supplement в текущем #13: exact accepted
GitHub merge + SHA-256 фактических blobs/paths, источники принятия и ограничения
исторического proof. Historical handoffs/commits/checksums не редактируются.
Для #10 новые hashes фиксируют действительные accepted bytes и **не утверждают**,
что прежние runtime tests выполнялись на них. Соответствующие current gates
проверяются заново. Для #14 можно принимать только design artifacts через #19,
без выдуманного исторического runtime handoff.

G00 читает supplement лишь после явного решения владельца, сверяя свежий GitHub,
ancestry, exact accepted blobs и закрытый schema. Несовпадение остаётся FAIL;
общее исключение «игнорировать старые hashes» не предлагается.

## Независимые нерешённые prerequisites

Нативный host AVX/AES отсутствует; этот proposal его не заменяет. Внешний
verification PostgreSQL ещё не подготовлен; standalone disposable G18 не
отменяет исходный запрет PostgreSQL container для полного launch. Для G04 не
найдены принятые coverage thresholds; они не будут подобраны под измеренный
результат для зелёного статуса. G03/G04/G08/G12/G17 exact scripts ещё не дают
приёмки. Ротация ранее раскрытого scoped material и publication не разрешены.
