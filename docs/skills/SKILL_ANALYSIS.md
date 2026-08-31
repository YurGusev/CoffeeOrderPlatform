# Анализ навыков для новой платформы

Навыки CoffeeOrderSystem `next-*` используются только как источник сведений,
а не как пакеты для копирования. Они предполагают Project #4, ветку
`next-generation`, C# parity, передачу владения БД, strangler routing, cutover и
вывод legacy. Для нового репозитория эти предположения неприменимы. Его
интеграционная линия — `develop`, а `main` остаётся стабильной линией.

## Соответствие возможностей

| Прежняя возможность | Владеющий навык CoffeeOrderPlatform |
|---|---|
| architecture router/foundation/system design | `coffee-platform-router`, `greenfield-microservices` |
| TypeScript and Node runtime | `node-service-runtime` |
| API architecture | `http-api-contracts` |
| Kafka/Outbox/Inbox | `event-driven-services` |
| PostgreSQL ownership | `postgres-service-ownership` |
| Customer/Catalog/Pricing | `customer-catalog-pricing` |
| Orders consistency core | `orders-lifecycle` |
| AROMA provider/cart safety | `aroma-cart-integration` |
| React handover | `react-operator-frontend` (new frontend, no handover) |
| Invoices and recovery | `invoices-service`, `artifact-processing` |
| Payments | `payments-service` |
| Hermes/VK/media | `channel-hermes-platform` |
| Work Center | `work-center-operations` |
| artifacts/documents/media | `artifact-processing` |
| Docker/CI/CD/deployment | `platform-delivery` |
| parity/reliability/testing | `reliability-verification` (greenfield evidence) |

Исключённые предположения: операции Gitea Project #4, `next-generation`, C#
differential parity как критерий приёмки, DB0→DB5, dual writers, legacy
strangler/decommission и автоматический перенос старых объектов разработки.

Kubernetes и training получат отдельные навыки после принятия первого
исполняемого среза. До этого архитектурную подготовку определяют
`platform-delivery` и канонические доменные документы, без заявления о
готовности runtime.
