# M07. Product/Variant Availability, Change Feed и Tombstones

## 1. Availability — отдельная временная ось

`Product.UpdatedAt` не является доказательством свежести availability.

Target хранит отдельно:

```text
IsAvailable
AvailabilityUpdatedAtUtc     # время последнего semantic availability transition/initial fact
CatalogSnapshotRef           # supplier proof, где применимо
CatalogSnapshotObservedAtUtc # freshness proof supplier source
```

Generic edit имени/описания не изменяет availability timestamp и не создаёт availability event.

## 2. Initial state vs transition

Initial availability при создании Product/Variant:

```text
SetInitial(...)
```

не должна ошибочно трактоваться как `EnteredStop/LeftStop` transition.

Дальнейшее boolean изменение:

```text
true -> false
false -> true
```

создаёт durable operational event в той же Catalog transaction.

## 3. Event stream identity

Availability stream существует на двух уровнях:

```text
product:{ProductRef}
product:{ProductRef}:variant:{VariantRef}
```

Kafka key = `CatalogAvailabilityStreamRef`, а не только ProductRef, чтобы ordering product/variant stream был определён явно.

Payload v1 содержит минимум:

```text
productRef
variantRef?
sourceSequence
isAvailable
isTombstone
availabilityUpdatedAtUtc
occurredAtUtc
```

Consumer применяет только событие с более новой source sequence для данного stream.

## 4. Product delete

Product delete должен атомарно создать:

```text
Product tombstone
+
Variant tombstone × every known Variant
```

до/вместе с cascade/local delete. Это сохраняет downstream knowledge даже если variant rows исчезнут после commit.

## 5. Variant delete

Variant delete публикует отдельный tombstone.

Orders, который уже имеет OrderItem snapshot, не теряет историю, но:

- future selection запрещается;
- availability projection становится unknown/unavailable fail-closed;
- active Desired по Variant больше не может иметь positive contribution.

## 6. Tombstone и AROMA CartKey

Критический инвариант:

> Catalog identity может исчезнуть, но Orders не должен потерять старый cart key до physical convergence к target `0`.

То есть target Orders consumer не «удаляет всё без следа». Он:

1. находит active Desired source по Product/VariantRef;
2. переводит contribution/resolution в состояние, дающее target `0`;
3. сохраняет old CartKey как previous convergence identity;
4. `DesiredRevision`/old `DesiredKeyVersion` увеличиваются;
5. convergence уменьшает/удаляет physical AROMA quantity;
6. только после stable zero/inactive retention старый key может быть GC.

## 7. `product_on_stop`

Только exact offer из complete successful supplier snapshot даёт `product_on_stop` fact.

```text
product_on_stop=true
→ TemporarilyUnavailable
→ known identity preserved
→ target 0
```

Это **не ManualReview**.

## 8. MissingFromSnapshot

Отсутствие ранее mapped offer в **validated complete** snapshot — не `product_on_stop` и не обязательно локальный `Product.IsAvailable=false`.

Но для cart-critical mapping это fail-closed fact:

```text
MappingStatus = MissingFromSnapshot
Desired Resolution = Unavailable (known previous identity retained)
target = 0
```

Только later `Ready` fact возвращает positive contribution.

Partial/failed/suspicious snapshot не может породить `MissingFromSnapshot`.

## 9. Orders read projection

`coffee.catalog.availability.v1` обслуживает также UI/Order availability projection.

Variant tombstone для historical unqualified OrderItem не должен подставлять boolean другого variant. Он становится `availability known = false` до bounded snapshot/reconciliation.

## 10. Anti-entropy

Kafka является primary delivery, но периодическая сверка Catalog snapshot → Orders projection допустима как repair.

Repair:

- idempotent;
- не вызывает AROMA cart;
- не придумывает availability при отсутствии complete supplier proof;
- не переписывает Order price snapshots.

## Effective orderability

Supplier availability — только один фактор. Target `EffectiveOrderability` считается из `OperatorEnabled`, supplier status, mapping readiness и tombstone. Tombstone также emits mapping `Removed`, сохраняя previous CartKey identity в Orders Desired history до verified physical convergence target=0.
