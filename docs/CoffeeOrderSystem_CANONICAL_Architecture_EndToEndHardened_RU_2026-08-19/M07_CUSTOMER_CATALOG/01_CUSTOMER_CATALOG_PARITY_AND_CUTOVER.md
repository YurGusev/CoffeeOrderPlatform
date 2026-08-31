# M07. Customer и Catalog — parity, cutover и связь с Orders/AROMA

## 1. Customer

Customer мигрирует как независимый owner идентичности и профиля клиента. Orders хранит только необходимые snapshots/opaque refs и не пишет Customer tables.

## 2. Catalog ownership

Catalog владеет:

```text
Product (Coffee)
CoffeeWeightVariant
ProductAlias
ProductPriceHistory
supplier availability
AROMA wholesale snapshots/current offers/discounts
AROMA offer mapping + audit/review state
Catalog Outbox facts
```

Catalog **не владеет**:

```text
Order / OrderItem
customer markup
Order procurement policy
Order Desired/Observed/Convergence
AROMA cart
Invoice/Payment
```

## 3. Два класса Catalog mutations

### 3.1 User/Admin Product mutation

Versioned `client-v1` command изменяет локальную product truth. Availability semantic change или delete/tombstone должен в той же Catalog transaction создать Outbox fact.

### 3.2 Supplier synchronization

```text
schedule/manual refresh
→ AROMA Gateway safe complete wholesale GET
→ quality validation/hash
→ Catalog snapshot transaction
→ availability/materialization/mapping
→ Catalog Outbox
→ Kafka facts
```

Полный supplier snapshot является target operational source для AROMA wholesale price/availability/mapping. Старый weekly Catalog price-list Excel runtime не переносится; Excel Orders/Invoices workflows — отдельные процессы.

## 4. Orders interaction

Допустимы разные режимы, и их нельзя смешивать:

| Orders operation | Catalog dependency | Rule |
|---|---|---|
| Draft create/edit product selection | synchronous Catalog read | allowed; no provider HTTP |
| Draft procurement preview/refresh | synchronous Catalog read of persisted supplier facts | explicit operator action only |
| Confirm | **none synchronous** | local Orders transaction only |
| Missing mapping preparation | Kafka command | Catalog resolves from persisted complete snapshot |
| Mapping/availability change | Kafka event Catalog→Orders | Orders Inbox + current-state gate |
| Positive cart convergence | synchronous read-only preflight proof | latest complete Catalog snapshot, no per-item provider request |

## 5. Mapping command

Canonical async request:

```text
coffee.catalog.mapping.commands.v1
key = CoffeeWeightVariantRef
```

Команда содержит stable refs/context. Catalog rechecks its current product/variant and latest complete snapshot. Provider DTO из Orders не принимается как truth.

Baseline mapping resolver **не делает per-item AROMA HTTP lookup**. Если complete snapshot отсутствует/устарел, результат fail-closed (`PendingMapping`/retry) и supplier refresh остаётся отдельным Catalog process.

## 6. Supplier availability

`product_on_stop=true` — точный supplier fact только из complete successful snapshot.

- `true` → known variant `TemporarilyUnavailable`, положительный cart contribution запрещён;
- later `false` → сохранённое mapping-review состояние может быть восстановлено;
- timeout/5xx/partial snapshot → availability **не меняется**;
- offer absent from validated complete snapshot → отдельный `MissingFromSnapshot` mapping fact; это не `product_on_stop`, но Orders fail-closed исключает положительный cart target до нового Ready proof.

## 7. Cutover order

```text
C0 characterization current C# Product/Catalog behavior
C1 target product/variant/alias read parity
C2 manual Product versioned mutation parity
C3 complete supplier snapshot shadow + quality gates
C4 availability/materialization/mapping shadow parity
C5 Catalog Outbox/Kafka/Orders Inbox parity
C6 Draft pricing read/refresh parity
C7 Catalog writable clone
C8 DB5 Catalog ownership
C9 enable target Catalog facts for Orders Desired
C10 remove C# Catalog writers/workers
```

## 8. Anti-cycle

Запрещено:

```text
Catalog -> Orders HTTP mutation
Catalog -> Orders DB
Catalog -> AROMA cart
Orders Confirm -> Catalog HTTP
Orders Confirm -> AROMA HTTP
mapping resolver -> per-item provider lookup as normal path
```

Catalog publishes facts; Orders owns reaction and physical cart convergence.
