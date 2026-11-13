// This file is auto-generated from canonical contracts/schemas events and their dependencies.

export const ordersAromaMessageSchemas = {
  "https://coffeeorderplatform.local/contracts/schemas/common/identifiers.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/common/identifiers.v1.schema.json",
      title: "CoffeeOrderPlatform common identifiers v1",
      $defs: {
        CustomerRef: {
          type: "string",
          pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        AddressRef: {
          type: "string",
          pattern: "^adr_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        ChannelLinkRef: {
          type: "string",
          pattern: "^chl_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        AuditRef: {
          type: "string",
          pattern: "^aud_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        ProductRef: {
          type: "string",
          pattern: "^prd_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        VariantRef: {
          type: "string",
          pattern: "^var_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        OfferRef: {
          type: "string",
          pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        SnapshotRef: {
          type: "string",
          pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        QuoteRef: {
          type: "string",
          pattern: "^prq_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        OrderRef: {
          type: "string",
          pattern: "^ord_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        ItemRef: {
          type: "string",
          pattern: "^itm_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        MessageId: {
          type: "string",
          pattern: "^msg_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        OperationRef: {
          type: "string",
          pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        SupplierRef: {
          type: "string",
          pattern: "^sup_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        AttemptRef: {
          type: "string",
          pattern: "^att_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        PolicyVersionRef: {
          type: "string",
          pattern: "^pvr_[0-9A-HJKMNP-TV-Z]{26}$",
        },
        CartScopeRef: {
          type: "string",
          const: "aroma-primary",
        },
        Version: {
          type: "string",
          pattern: "^(0|[1-9][0-9]*)$",
        },
        UUID: {
          $ref: "#/$defs/Uuid",
        },
        Uuid: {
          type: "string",
          pattern:
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
        },
      },
    },
  "https://coffeeorderplatform.local/contracts/schemas/common/message-envelope.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/common/message-envelope.v1.schema.json",
      title: "CoffeeOrderPlatform message envelope v1",
      $defs: {
        Aggregate: {
          type: "object",
          additionalProperties: false,
          required: ["type", "ref", "version"],
          properties: {
            type: {
              type: "string",
              pattern: "^[A-Za-z][A-Za-z0-9._-]{0,63}$",
            },
            ref: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            version: {
              $ref: "identifiers.v1.schema.json#/$defs/Version",
            },
          },
        },
        MessageEnvelope: {
          type: "object",
          additionalProperties: false,
          required: [
            "envelopeVersion",
            "messageId",
            "messageType",
            "occurredAt",
            "producer",
            "correlationId",
            "causationId",
            "traceparent",
            "aggregate",
            "payload",
          ],
          properties: {
            envelopeVersion: {
              type: "string",
              const: "1",
            },
            messageId: {
              $ref: "identifiers.v1.schema.json#/$defs/MessageId",
            },
            messageType: {
              type: "string",
              pattern: "^[A-Za-z][A-Za-z0-9]+\\.v[1-9][0-9]*$",
            },
            occurredAt: {
              $ref: "money-version-time.v1.schema.json#/$defs/Timestamp",
            },
            producer: {
              type: "string",
              pattern: "^[a-z][a-z0-9-]{0,63}$",
            },
            correlationId: {
              $ref: "identifiers.v1.schema.json#/$defs/Uuid",
            },
            causationId: {
              anyOf: [
                {
                  $ref: "identifiers.v1.schema.json#/$defs/MessageId",
                },
                {
                  type: "null",
                },
              ],
            },
            traceparent: {
              $ref: "money-version-time.v1.schema.json#/$defs/Traceparent",
            },
            aggregate: {
              $ref: "#/$defs/Aggregate",
            },
            payload: {},
          },
        },
      },
    },
  "https://coffeeorderplatform.local/contracts/schemas/common/money-version-time.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/common/money-version-time.v1.schema.json",
      title: "CoffeeOrderPlatform common money, quantity and time v1",
      $defs: {
        MoneyMinor: {
          type: "string",
          pattern: "^-?(0|[1-9][0-9]*)$",
        },
        Revision: {
          $ref: "identifiers.v1.schema.json#/$defs/Version",
        },
        QuantityDecimal: {
          type: "string",
          pattern:
            "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$",
        },
        QuantityMilli: {
          type: "string",
          pattern: "^(0|[1-9][0-9]*)$",
        },
        ProviderQuantity: {
          type: "string",
          pattern: "^(?:[1-9][0-9]*)(?:\\.[0-9]+)?$|^0\\.(?!0+$)[0-9]+$",
        },
        HashSha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
        Hash: {
          $ref: "#/$defs/HashSha256",
        },
        Timestamp: {
          type: "string",
          format: "date-time",
          pattern:
            "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
        },
        Currency: {
          type: "string",
          const: "RUB",
        },
        Traceparent: {
          allOf: [
            {
              type: "string",
              pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$",
            },
            {
              not: {
                type: "string",
                pattern: "^ff-",
              },
            },
            {
              not: {
                type: "string",
                pattern: "^[0-9a-f]{2}-0{32}-",
              },
            },
            {
              not: {
                type: "string",
                pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-0{16}-",
              },
            },
          ],
        },
      },
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/aroma-convergence-changed.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/aroma-convergence-changed.v1.schema.json",
      title: "AromaConvergenceChanged.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "AromaConvergenceChanged.v1",
            },
            producer: {
              const: "aroma-convergence",
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: [
                "cartScopeRef",
                "desiredRevision",
                "observedRevision",
                "attemptRef",
                "attemptState",
                "changedAt",
                "blockerCodes",
              ],
              properties: {
                cartScopeRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/CartScopeRef",
                },
                desiredRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                observedRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                attemptRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/AttemptRef",
                },
                attemptState: {
                  type: "string",
                  enum: [
                    "NoOpInSync",
                    "VerifiedInSync",
                    "OutOfSync",
                    "Blocked",
                    "UnknownOutcome",
                    "Failed",
                  ],
                },
                changedAt: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/Timestamp",
                },
                blockerCodes: {
                  type: "array",
                  uniqueItems: true,
                  maxItems: 100,
                  items: {
                    type: "string",
                    pattern: "^[A-Z][A-Z0-9_]{0,63}$",
                  },
                },
              },
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/aroma-convergence-requested.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/aroma-convergence-requested.v1.schema.json",
      title: "AromaConvergenceRequested.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "AromaConvergenceRequested.v1",
            },
            producer: {
              enum: ["orders-service", "orders-aroma-preparation"],
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: [
                "cartScopeRef",
                "desiredRevision",
                "reason",
                "orderRef",
              ],
              properties: {
                cartScopeRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/CartScopeRef",
                },
                desiredRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                reason: {
                  type: "string",
                  enum: [
                    "OrderConfirmed",
                    "CatalogChanged",
                    "OperatorRequested",
                    "Recovery",
                  ],
                },
                orderRef: {
                  anyOf: [
                    {
                      $ref: "../common/identifiers.v1.schema.json#/$defs/OrderRef",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/aroma-observation-changed.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/aroma-observation-changed.v1.schema.json",
      title: "AromaObservationChanged.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "AromaObservationChanged.v1",
            },
            producer: {
              enum: ["aroma-observer", "aroma-convergence"],
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: [
                "cartScopeRef",
                "observedRevision",
                "observedAt",
                "observationState",
                "cartFingerprint",
              ],
              properties: {
                cartScopeRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/CartScopeRef",
                },
                observedRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                observedAt: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/Timestamp",
                },
                observationState: {
                  type: "string",
                  const: "Complete",
                },
                cartFingerprint: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/HashSha256",
                },
              },
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/catalog-mapping-changed.v2.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/catalog-mapping-changed.v2.schema.json",
      title: "CatalogMappingChanged.v2",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "CatalogMappingChanged.v2",
            },
            producer: {
              const: "catalog-activation-worker",
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: [
                "productRef",
                "variantRef",
                "offerRef",
                "catalogSnapshotRevision",
                "mappingRevision",
                "mappingState",
                "availability",
                "effectiveAt",
              ],
              properties: {
                productRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/ProductRef",
                },
                variantRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/VariantRef",
                },
                offerRef: {
                  anyOf: [
                    {
                      $ref: "../common/identifiers.v1.schema.json#/$defs/OfferRef",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                catalogSnapshotRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                mappingRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                mappingState: {
                  type: "string",
                  enum: ["Active", "Missing", "Stopped"],
                },
                availability: {
                  type: "string",
                  enum: ["Available", "Unavailable", "Stopped"],
                },
                effectiveAt: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/Timestamp",
                },
              },
              allOf: [
                {
                  if: {
                    properties: {
                      mappingState: {
                        const: "Active",
                      },
                    },
                  },
                  then: {
                    properties: {
                      offerRef: {
                        $ref: "../common/identifiers.v1.schema.json#/$defs/OfferRef",
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      mappingState: {
                        enum: ["Missing", "Stopped"],
                      },
                    },
                  },
                  then: {
                    properties: {
                      offerRef: {
                        type: "null",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/order-confirmed.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/order-confirmed.v1.schema.json",
      title: "OrderConfirmed.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "OrderConfirmed.v1",
            },
            producer: {
              const: "orders-service",
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: [
                "orderRef",
                "orderVersion",
                "customerRef",
                "confirmedAt",
                "contributionRevision",
              ],
              properties: {
                orderRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/OrderRef",
                },
                orderVersion: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                customerRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/CustomerRef",
                },
                confirmedAt: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/Timestamp",
                },
                contributionRevision: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
              },
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/order-reconciliation-requested.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/order-reconciliation-requested.v1.schema.json",
      title: "OrderReconciliationRequested.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "OrderReconciliationRequested.v1",
            },
            producer: {
              const: "orders-service",
            },
            aggregate: {
              type: "object",
              properties: {
                type: {
                  const: "Order",
                },
                ref: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/OrderRef",
                },
              },
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: ["orderRef", "orderVersion", "requestedAt"],
              properties: {
                orderRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/OrderRef",
                },
                orderVersion: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                requestedAt: {
                  $ref: "../common/money-version-time.v1.schema.json#/$defs/Timestamp",
                },
              },
            },
          },
        },
      ],
    },
  "https://coffeeorderplatform.local/contracts/schemas/events/realtime-invalidated.v1.schema.json":
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://coffeeorderplatform.local/contracts/schemas/events/realtime-invalidated.v1.schema.json",
      title: "RealtimeInvalidated.v1",
      allOf: [
        {
          $ref: "../common/message-envelope.v1.schema.json#/$defs/MessageEnvelope",
        },
        {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: {
              const: "RealtimeInvalidated.v1",
            },
            producer: {
              enum: ["orders-service", "orders-aroma-preparation"],
            },
            payload: {
              type: "object",
              additionalProperties: false,
              required: ["subjectType", "subjectRef", "ownerVersion", "reason"],
              properties: {
                subjectType: {
                  type: "string",
                  const: "order",
                },
                subjectRef: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/OrderRef",
                },
                ownerVersion: {
                  $ref: "../common/identifiers.v1.schema.json#/$defs/Version",
                },
                reason: {
                  type: "string",
                  enum: ["OrderChanged", "AromaStateChanged"],
                },
              },
            },
          },
        },
      ],
    },
} as const;
