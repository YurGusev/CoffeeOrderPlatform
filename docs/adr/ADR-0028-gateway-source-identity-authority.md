# ADR-0028: Gateway-owned source identity для Catalog

- Статус: принято для launch v1.
- Область: source identity provider records и authority/config synchronization.
- Владелец: `aroma-gateway`; Catalog остаётся владельцем staging, activation и
  стабильных `productRef`/`variantRef`/`offerRef`.

## Контекст

Catalog должен сопоставлять записи поставщика между полными snapshots, не
передавая raw provider identifiers за пределы Gateway. Identity обязана быть
детерминированной, разделять product/variant/offer/grind domains и не зависеть от
изменяемых display/price/availability facts. Предыдущая profile-запись с
`supplierProductRef`, `supplierVariantRef`, `normalizedPack` и `normalizedUnit`
не является согласованным byte-level контрактом.

## Решение

Gateway использует только `aroma.catalogIdentityKeyV1` как отдельный typed key
input. Для `supplierRef`, строгого `entityType` (`product | variant | offer | grind`) и
raw provider identifier helper строит ровно следующую последовательность байт. Для
`grind` raw identifier является provider grind ID; схема и ключ остаются теми же,
а product/variant/offer hashes не меняются:

```text
UTF-8("hmac-sha256-v1")
|| 0x00
|| UTF-8(supplierRef)
|| 0x00
|| UTF-8(entityType)
|| 0x00
|| UTF-8(NFC(rawProviderIdentifier))
```

`0x00` — один NUL byte. Supplier ref принимает canonical `sup_<ULID>`. Raw ID
не trim/lowercase-ится; пустой, NUL-containing или malformed input отклоняется.
Результат HMAC-SHA256 сериализуется ровно как 64 lowercase hexadecimal
символа. Key не входит в logs, errors или payloads и не читается из общего
конфига внутри helper.

Helper возвращает только source identity proof. Gateway никогда не генерирует
`variantRef`/variant ID или другой Catalog owner ref; Catalog activation
назначает и сохраняет stable refs. Gateway не пишет в Catalog DB.

Одинаковая identity с несовместимым immutable semantic fingerprint закрывает
snapshot как `SOURCE_IDENTITY_COLLISION`; mutable facts создают новую snapshot
revision и не меняют identity. Key rotation не является автоматической:
отдельный ADR и alias migration обязательны.

Canonical Catalog staging table называется `catalog.supplier_snapshots`; роли
`catalog-supplier-sync` и `catalog-activation-worker` используют это имя, а
`catalog-activation-worker` отдельно владеет Catalog `source_identities` и
active tables по существующему owner contract.

## Authority synchronization

Следующие артефакты являются одной проекцией этого ADR:

- `platform/launch-v1-runtime-profile.json` и его JSON Schema фиксируют scheme,
  UTF-8 framing, literal separator byte, allowed entity types, validation,
  output encoding, dedicated secret input и запрет генерации variant ID;
- `scripts/validate-launch-authority.py` принимает только эту точную проекцию;
- `config/database-role-map.json` использует `supplier_snapshots`;
- `docs/launch/15_CATALOG_IMPLEMENTATION_SPEC.md` описывает тот же wire/domain
  contract.

Разные значения между этими файлами блокируют authority/config checks.

## Последствия и границы

Catalog receives hashes and semantic facts, но не raw provider IDs и не Gateway
secret. Existing binding proof остаётся immutable и не становится разрешением на
cart mutation. Provider decoder, Catalog importer/activation и cart не меняются
этим ADR; runtime/provider integration остаётся отдельной поставкой.

Проверка этой поставки ограничена source-identity, static, authority и config
checks. Полный launch gate, live PostgreSQL, provider calls и cart behavior этим
ADR не подтверждаются.
