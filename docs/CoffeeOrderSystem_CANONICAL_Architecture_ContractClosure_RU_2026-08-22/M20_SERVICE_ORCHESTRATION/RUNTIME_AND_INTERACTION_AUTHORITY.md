# M20 contract closure — executable and interaction authority

The locked baseline `roles` shape remains the complete runtime-role contract.
The non-isomorphic PricingV2 `addWorkloads` delta is superseded by
`runtime-workload-registry.closure.json`, whose `addRoles` entries carry every
required field explicitly. There are no runtime-derived defaults.

The deterministic merge is:

```text
baseline roles keyed by name
  + closure addRoles keyed by name
  = 42 unique roles
```

Every durable consumer group binds to exactly one executable role. Every topic
produced by a materialized M20 runtime role names that executable role, even
where the topic's business owner remains a bounded-context label. M06 may retain
an explicit authority-only logical producer binding for a bounded context that
has no audited runtime workload; those producer identities are excluded from
runtime evidence and from the 42-role count until materialized. Runtime role
and bounded context are never treated as synonyms.

The media pipeline is Kafka-driven:

```text
channel-ingress
  -> coffee.channels.media.commands.v1
  -> channel-media-worker
  -> coffee.channels.transcription.commands.v1
  -> channel-transcription-worker
  -> coffee.channels.inbound.v1
```

Large media and transcript bytes stay in Artifact Storage; Kafka transports
only bounded references, hashes, sizes and correlation metadata.

`service-interaction-policy.closure.json` is an additive/denied-edge authority.
It does not deploy roles, create topics, apply ACLs or authorize production
traffic.
