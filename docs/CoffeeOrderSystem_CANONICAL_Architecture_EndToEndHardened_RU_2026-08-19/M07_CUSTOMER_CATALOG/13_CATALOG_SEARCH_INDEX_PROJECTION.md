# M07. Catalog search/index projection

## Decision

Отдельные `coffee.catalog.indexing.commands/events` удалены из canonical baseline как лишняя transport-абстракция.

`catalog-search-indexer` — Catalog-owned projection consumer группы `catalog-indexing` на `coffee.catalog.products.v1`.

```text
Catalog Product transaction
  -> Outbox CatalogProductChanged
  -> coffee.catalog.products.v1
  -> catalog-search-indexer
  -> Catalog-owned search projection
```

## Authority

Search index никогда не является Product truth. При отсутствии/отставании index:

- operator/client reads идут в Catalog PostgreSQL;
- Hermes `search_products` может использовать index для ranking, но final Product/Variant availability/price возвращается authoritative Catalog read;
- stale index result не может выбрать raw AROMA offer/mapping.

## Storage

Baseline — PostgreSQL full-text/trigram/search projection в Catalog-owned DB. Vector/Qdrant добавляется только measured ADR; отдельные Kafka indexing topics тогда проектируются заново.
