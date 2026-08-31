# M07. Product Domain и семантика обновления Товаров

## 1. Product — Catalog source of truth

Текущий `develop` уже определяет `Catalog/Domain/Coffee.cs` как единственный источник product truth. Target сохраняет семантику, но переименования `Coffee → Product` допустимы только как contract-compatible migration.

Target aggregate/read model:

```text
Product
├─ ProductRef
├─ SupplierArticle        stable supplier identity
├─ Name / Description
├─ Category / SubCategory / ProductFamily
├─ Package metadata
├─ GrindType
├─ canonical local price facts
├─ IsAvailable
├─ AvailabilityUpdatedAtUtc
├─ Version                application-owned optimistic version
├─ Variants[]
└─ Aliases[]
```

`ProductRef`/`VariantRef` после cutover не должны зависеть от PostgreSQL `xmin`. `xmin` остаётся только legacy concurrency evidence; target использует application-owned `BIGINT version`.

## 2. Variant — cart-critical identity

`CoffeeWeightVariant`/target `ProductVariant` является стабильной package identity для:

- supplier offer mapping;
- order product selection;
- Draft procurement quote;
- Catalog→Orders mapping/availability facts.

Для piece SKU допускается internal non-weight key `0`; это **identity marker**, а не физический `0 г`. Он никогда не попадает в Order snapshot как вес.

## 3. Alias — search concern, не supplier identity

Alias принадлежит Catalog и может ссылаться на Product/Variant. Alias:

- влияет на поиск/Hermes resolution;
- не меняет SupplierArticle;
- не меняет AROMA CartKey;
- не должен автоматически менять уже сохранённый OrderItem snapshot.

## 4. Классы Product change

Нельзя обрабатывать все поля одинаково.

| Change | Future Catalog reads | Existing Draft | Existing Confirmed | AROMA Desired/cart |
|---|---|---|---|---|
| Name/Description | immediately | display may refresh only by explicit product reselection/read | snapshot remains historical | no effect |
| Category/ProductFamily | future resolution/pricing | explicit re-evaluation if operator requests | no silent rewrite | mapping may require revalidation if cart identity depends on family |
| SupplierArticle | supplier identity change | explicit user decision | no silent snapshot rewrite | invalidate/remap affected Variant; fail closed until proof |
| Variant package/weight | future selection | explicit Draft change/reprice | no silent OrderItem identity rewrite | mapping remap/target recalculation required |
| Supplier/list price | future quote | only explicit Draft preview/refresh | no automatic customer/order rewrite | **no quantity/cart target effect** |
| Availability | immediate operational fact | UI becomes unavailable | existing Confirmed Desired can go target 0 | convergence reduce/delete |
| Mapping | operational identity | readiness changes | existing Desired remapped | old key down/new key up |
| Product/Variant delete | hidden from future use | fail closed | historical snapshot remains | active Desired target 0 + tombstone |

## 5. Versioned manual mutations

Target `client-v1` keeps current Products boundary semantics:

```text
PUT /api/client-v1/products/{ref}
DELETE /api/client-v1/products/{ref}
PUT /api/client-v1/products/{ref}/variants/{variantRef}
DELETE /api/client-v1/products/{ref}/variants/{variantRef}
```

Unsafe mutation requires `expectedVersion`.

Response semantics:

```text
missing version -> validation error
stale version   -> 409 Conflict
valid version   -> atomic mutation + outbox if semantic downstream fact changed
```

Destructive bulk delete requires explicit scope/reason/confirmation phrase and audit actor.

## 6. Product delete is not historical Order delete

Orders stores immutable/snapshot product data. Therefore removal of Catalog Product does not erase existing Order history.

Target delete transaction must:

1. mark/remove Catalog identity according to data-retention policy;
2. append Product/Variant tombstone events for every affected stream;
3. invalidate future search/selection;
4. cause active Orders Desired contributions for affected variants to fail closed;
5. preserve old Desired CartKey until target-zero convergence has enough identity to remove/reduce the physical AROMA line.

## 7. Semantic no-op

Changing only audit text, verification timestamp or re-saving the same effective product/mapping/availability value must not:

- increment semantic Catalog availability/mapping revision;
- emit duplicate business fact;
- advance Orders DesiredRevision;
- trigger extra AROMA mutation.

## 8. Current C# parity points

Behavioral sources in `develop`:

```text
src/CoffeeOrderSystem.Modules.Catalog/Domain/Coffee.cs
src/CoffeeOrderSystem.Modules.Catalog/Domain/CoffeeWeightVariant.cs
src/CoffeeOrderSystem.Modules.Catalog/Application/Services/AvailabilityTransition.cs
src/CoffeeOrderSystem.Modules.Catalog/Application/UseCases/ProductsUseCase.cs
src/CoffeeOrderSystem.Modules.Catalog/Api/ProductsController.cs
src/CoffeeOrderSystem.Modules.Catalog/Infrastructure/CatalogDbContext.cs
```

Target tests должны сравнивать business outcomes, а не EF/entity structure.

## Source separation: operator vs supplier

Target не переносит ambiguous legacy `Coffee.IsAvailable/BasePrice` как один authoritative факт.

```text
OperatorEnabled
SupplierAvailability = Available | Unavailable | Unknown
MappingStatus
IsDeleted
        ↓
EffectiveOrderability
```

Supplier snapshot **не может включить** товар, который оператор disabled. Operator edit **не может подделать** supplier availability.

Price sources также разделены:

```text
SupplierListPrice + SupplierPriceObservedAt + SupplierSnapshotRef
CustomerReferencePrice (optional operator metadata)
ManualSupplierPriceOverride (only explicit policy/reason/expiry, if enabled)
```

Orders procurement quote использует supplier price/provenance policy; generic Product edit никогда не переписывает supplier truth.
