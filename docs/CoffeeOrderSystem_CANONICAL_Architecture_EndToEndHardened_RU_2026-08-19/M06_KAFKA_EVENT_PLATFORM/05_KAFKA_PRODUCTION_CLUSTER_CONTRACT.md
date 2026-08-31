# M06. Kafka Production Cluster Contract

## 1. Статус документа

Этот документ является нормативным production contract для Kafka-платформы CoffeeOrderSystem. Он определяет минимальные гарантии самого Kafka-кластера. Настройки приложений из `04_NODEJS_KAFKA_RUNTIME.md` не могут компенсировать нарушение этого контракта.

## 2. Роль Kafka

Kafka является durable asynchronous backbone для:

- inbound channel intake после provider verification;
- integration commands;
- integration events;
- fan-out между bounded contexts;
- replayable read projections;
- burst absorption;
- асинхронного Hermes turn flow;
- realtime invalidation hints.

Kafka не является:

- business database;
- distributed transaction coordinator для PostgreSQL + external HTTP;
- источником истины Orders/Payments/AROMA;
- timer/scheduler;
- заменой Inbox/idempotency/reconciliation.

## 3. Production deployment baseline

Для self-managed production:

```text
Kafka 4.x KRaft

controllers: 3 minimum
brokers:     3 minimum

controller role != broker role
```

Critical deployment не использует combined `broker,controller` process role. Контроллеры и brokers имеют отдельные listeners, identities, storage и lifecycle.

Managed Kafka разрешён, если он предоставляет эквивалентные или более сильные гарантии durability, failure-domain placement, ACL, quotas, monitoring и DR.

## 4. Failure domains

При наличии нескольких availability zones/racks:

```text
broker.rack = <zone-or-rack>
```

Replicas критичных topics должны распределяться между разными failure domains. Нельзя считать `replication.factor=3` достаточным, если все три replicas физически находятся в одном failure domain.

## 5. Critical topic durability profile

Для `TIER_A_INGRESS`, `DOMAIN_LIFECYCLE` и side-effecting `ASYNC_COMMAND` streams production baseline:

```text
replication.factor = 3
min.insync.replicas = 2
producer acks       = all
enable.idempotence  = true
```

Если ISR становится меньше `min.insync.replicas`, запись должна fail closed. Availability не имеет права silently победить durability для этих классов.

## 6. Broker safety defaults

Production config явно задаёт и проверяет:

```text
auto.create.topics.enable = false
unclean.leader.election.enable = false
```

Application principals не имеют права создавать/удалять topics или изменять cluster-wide configuration.

Внутренние Kafka topics (`__consumer_offsets`, transaction state при использовании Kafka transactions) должны иметь production replication profile, совместимый с отказом одного broker.

## 7. Client identity

Каждый workload получает стабильный `client.id`, например:

```text
coffee-channel-ingress
coffee-channel-intake
coffee-hermes-dispatcher
coffee-payments
coffee-realtime
coffee-replay-tool
```

`client.id` используется для:

- metrics;
- quotas;
- incident attribution;
- ACL/audit correlation.

Нельзя использовать один generic `coffee-app` client ID для всех workloads.

## 8. Security

Production Kafka требует:

- encrypted transport;
- authenticated workload principals;
- least-privilege ACL;
- отдельные credentials по workload role;
- secret injection через runtime secret store;
- отсутствие broker/client secrets в Git, Docker image и Kafka payload.

Controller listener не публикуется application clients.

## 9. Production creation policy

Topics создаются только через version-controlled IaC/manifest из M06/M16.

Запрещено:

```text
application starts
-> missing topic
-> auto create topic
-> application continues
```

Правильно:

```text
PR changes topic registry
-> CI validates policy
-> environment manifest applied
-> topic config attested
-> application deployment allowed
```

## 10. Acceptance gate

Production Kafka platform не принимается без доказательств:

1. controller quorum survives one controller failure;
2. critical topic survives one broker failure without acknowledged message loss;
3. write fails when ISR < minISR;
4. automatic topic creation is disabled server-side and client-side;
5. rack/zone placement verified where multiple failure domains exist;
6. application principal cannot create/delete/alter topics;
7. client quotas and metrics identify workload independently;
8. broker restart/recovery drill completed;
9. monitoring exposes under-replication/offline/minISR/controller health.

## 11. Official references

- Apache Kafka KRaft: https://kafka.apache.org/43/operations/kraft/
- Apache Kafka broker/topic configs: https://kafka.apache.org/43/configuration/broker-configs/
- Apache Kafka producer configs: https://kafka.apache.org/43/generated/producer_config.html
- Apache Kafka listener configuration: https://kafka.apache.org/43/security/listener-configuration/
