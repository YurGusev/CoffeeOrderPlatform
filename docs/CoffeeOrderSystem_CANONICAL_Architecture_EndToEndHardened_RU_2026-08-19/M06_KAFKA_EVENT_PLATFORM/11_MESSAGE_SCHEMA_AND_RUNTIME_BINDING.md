# M06. Message schema + runtime binding completeness

Machine-readable sources:

```text
kafka-topic-registry.yml
message-schema-registry.yml
../M20_SERVICE_ORCHESTRATION/runtime-workload-registry.yml
```

Production CI requires:

- 100% topic payload-schema coverage;
- 100% message-schema registry coverage;
- valid fixture per message schema;
- explicit production partitions;
- consumerGroup→runtimeRole mapping;
- no forbidden realtime domain consumers;
- UInt64 versions as decimal strings.

`catalog.indexing.commands/events` are superseded; Catalog search indexer consumes `coffee.catalog.products.v1` directly.
