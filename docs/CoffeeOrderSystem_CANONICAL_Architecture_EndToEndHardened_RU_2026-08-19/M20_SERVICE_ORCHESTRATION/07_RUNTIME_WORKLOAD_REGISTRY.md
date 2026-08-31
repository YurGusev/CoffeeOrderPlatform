# M20. Canonical Runtime Workload Registry

`runtime-workload-registry.yml` — единственный source of truth для mapping:

```text
consumer group
 -> executable runtime role
 -> bounded-context owner
 -> DB principal
 -> produced topics
 -> HTTP/provider permissions
 -> Compose/Kubernetes workload
 -> concurrency/drain policy
 -> network zone
 -> SLO reference
```

## Required fields

Для каждого runtime role фиксируются:

- `name`, `owner`, `executable`;
- `productionCritical`;
- `composeService`, `kubernetesWorkload`, `workloadKind`;
- `dbPrincipal`;
- `consumerGroups`, `producesTopics`;
- `allowedHttpTargets`, `allowedProviders`, `httpSurfaces`;
- `concurrencyPolicy`, `drainPolicy`;
- `networkZone`;
- `requiredSecretClasses` — только классы секретов, без значений;
- `sloRef`;
- `stateful`.

M06 Kafka Registry не может содержать durable consumer group без **ровно одного** binding в этом registry, кроме специального `ephemeral-per-replica` для realtime.

Compose/Kubernetes должны включать каждый `productionCritical: true` role. Production release CI сравнивает manifests с registry; отсутствие critical workload — ошибка.

Generated service matrices/Mermaid считаются views. При конфликте побеждают `service-interaction-policy.yml` + `runtime-workload-registry.yml`.
