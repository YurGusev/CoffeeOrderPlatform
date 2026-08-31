# CoffeeOrderSystem — Supplier-Owned AROMA Credential Exception

**Revision date:** 2026-08-28<br>
**Revision ID:** `DEC-PLT-M00-SEC-003`<br>
**Parent revision:** `ArchitectureContractClosure`<br>
**Status:** `governed-external-owner-exception`

Это узкое additive-исключение для класса логина и пароля AROMA, который
принадлежит поставщику/производителю и не может быть изменён владельцем этого
репозитория. Значения, хеши и сырые логи никогда не записываются в этот root.
Пока внешнее владение сохраняется, владелец репозитория не должен изменять
эти credentials: rotation, revocation и cleanup выполняются только
поставщиком/производителем. Это не бессрочное разрешение: при окончании
внешнего владения или срабатывании expiry trigger требуется revalidation.
Независимо от drift следующая обязательная revalidation назначена на `2026-11-28`.
Дата проверяется операционным preflight перед acceptance: canonical
integrity gate детерминированно проверяет точную запись даты, но не
зависит от wall clock. После этой даты новая acceptance без нового
revalidation evidence запрещена.

Покрываются только явно перечисленные server-side aliases `AROMA_AUTH_EMAIL`,
`AROMA_AUTH_PASSWORD`, их профильные формы и эквивалентные configuration aliases
AROMA для login/password. Session/cookie state,
Gitea/CI/API, database, VK, payment, AI/model-provider, JWT/signing и иные
repository-owned credentials в исключение не входят. Для всех этих классов
требования #1086 остаются действующими.

Совместимость ограничена владельцем `YurGusev` и точным collaborator
`project4-migrator` с permission `write`, `admin=false`, защищённым источником
токена с mode `0600`, без review/approval/self-approval authority и без доступа
к production credentials. Любая другая identity, collaborator, bot или admin
делает правило недействительным.

Предшествующее исключение #1172 и ADR-0015 истекло и является историческим;
оно не возобновляется. Эта revision supersedes только completion requirement
#1086 для supplier-owned AROMA login/password при указанном exact predicate.
Она не разрешает history rewrite, production cutover/deploy или mutation
любых иных credentials. Владелец репозитория не должен мутировать
supplier-owned AROMA credentials, пока сохраняется external ownership.

Expiry/review triggers перечислены в `SECURITY_EXCEPTION.json`: visibility или
access drift, изменение owner/scope/alias, production/shared deployment,
изменение защиты migrator token, наступление review date и изменение границы
#1086. До отдельной revalidation правило не расширяется.

Acceptance evidence is intentionally secret-free: `repository-owner-scope-decision`
имеет статус `accepted`, а `supplier-ownership` —
`external-owner-confirmed`. Это подтверждает границу владения и scope decision,
но не утверждает, что provider rotation выполнена.

## Release controls

`REVISION_MANIFEST.yml` описывает exact parent и пятиэлементную chain,
`PREVIOUS_RELEASE_LOCK.json` связывает решение с parent tree, а `SHA256SUMS.txt`
покрывает все файлы root, кроме самого checksum-файла. Машинно проверяемая
политика находится в `SECURITY_EXCEPTION.json`.

## Verification

```bash
python3 scripts/verify-canonical-release-integrity.py
python3 scripts/test-canonical-release-integrity.py
```

Проверки current tree не являются доказательством истории. Этот
specification-only overlay не меняет runtime, deployment, cutover, provider
account или production routing.
