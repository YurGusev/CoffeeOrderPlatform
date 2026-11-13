// This file is auto-generated from contracts/openapi/internal-v1.yaml.

export const internalV1Schemas = {
  CustomerOrderInput: {
    type: "object",
    additionalProperties: false,
    required: ["customerRef", "customerVersion", "displayName", "state"],
    properties: {
      customerRef: {
        type: "string",
        pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      customerVersion: {
        type: "string",
        pattern: "^(0|[1-9][0-9]*)$",
      },
      displayName: {
        type: "string",
        minLength: 1,
        maxLength: 200,
      },
      state: {
        type: "string",
        enum: ["Active", "Inactive"],
      },
    },
  },
  CustomerRef: {
    type: "string",
    pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
  },
  ProblemDetails: {
    type: "object",
    additionalProperties: false,
    required: [
      "type",
      "title",
      "status",
      "code",
      "detail",
      "instance",
      "correlationId",
      "errors",
    ],
    properties: {
      type: {
        type: "string",
        format: "uri-reference",
        pattern:
          "^(?!(?![A-Za-z][A-Za-z0-9+\\-.]*:)[^/?#]*:)(?:[A-Za-z][A-Za-z0-9+\\-.]*:)?(?:\\/\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9A-Fa-f]{1,4}:){6}|::(?:[0-9A-Fa-f]{1,4}:){5}|(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,1}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){3}|(?:(?:[0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){2}|(?:(?:[0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}:|(?:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})?::)(?:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|(?:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})?::)|[Vv][0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~!$&'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)|(?:[A-Za-z0-9\\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::\\d*)?(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*|\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?|(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?(?:\\?(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$",
        minLength: 1,
        maxLength: 2048,
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 200,
      },
      status: {
        type: "integer",
        minimum: 400,
        maximum: 599,
      },
      code: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9_]{0,63}$",
      },
      detail: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
      },
      instance: {
        type: "string",
        format: "uri-reference",
        pattern:
          "^(?!(?![A-Za-z][A-Za-z0-9+\\-.]*:)[^/?#]*:)(?:[A-Za-z][A-Za-z0-9+\\-.]*:)?(?:\\/\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9A-Fa-f]{1,4}:){6}|::(?:[0-9A-Fa-f]{1,4}:){5}|(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,1}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){3}|(?:(?:[0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){2}|(?:(?:[0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}:|(?:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})?::)(?:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|(?:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})?::)|[Vv][0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~!$&'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)|(?:[A-Za-z0-9\\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::\\d*)?(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*|\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?|(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?(?:\\?(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$",
        minLength: 1,
        maxLength: 2048,
      },
      correlationId: {
        type: "string",
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
      },
      errors: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: {
              type: "string",
              pattern: "^[A-Z][A-Z0-9_]{0,63}$",
            },
            message: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
            field: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
          },
        },
      },
    },
  },
  AromaCatalogExportRequest: {
    type: "object",
    additionalProperties: false,
    required: ["snapshotRef", "supplierRef"],
    properties: {
      snapshotRef: {
        type: "string",
        pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      supplierRef: {
        type: "string",
        pattern: "^sup_[0-9A-HJKMNP-TV-Z]{26}$",
      },
    },
  },
  AromaCatalogExportRecord: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: [
          "streamVersion",
          "recordType",
          "snapshotRef",
          "supplierRef",
          "providerSnapshotRef",
          "startedAt",
        ],
        properties: {
          streamVersion: {
            const: "1",
          },
          recordType: {
            const: "snapshot-started",
          },
          snapshotRef: {
            type: "string",
            pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          supplierRef: {
            type: "string",
            pattern: "^sup_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          providerSnapshotRef: {
            type: "string",
            minLength: 1,
            maxLength: 256,
          },
          startedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "streamVersion",
          "recordType",
          "snapshotRef",
          "batchNumber",
          "offerCount",
          "uncompressedBytes",
          "batchHash",
          "previousBatchHash",
          "items",
        ],
        properties: {
          streamVersion: {
            const: "1",
          },
          recordType: {
            const: "snapshot-batch",
          },
          snapshotRef: {
            type: "string",
            pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          batchNumber: {
            type: "integer",
            minimum: 0,
          },
          offerCount: {
            type: "integer",
            minimum: 0,
            maximum: 500,
          },
          uncompressedBytes: {
            type: "integer",
            minimum: 0,
            maximum: 2097152,
          },
          batchHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          previousBatchHash: {
            type: ["string", "null"],
            pattern: "^[a-f0-9]{64}$",
          },
          items: {
            type: "array",
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "sourceProductKeyHash",
                "sourceVariantKeyHash",
                "sourceOfferKeyHash",
                "displayName",
                "unit",
                "supplierUnitMinor",
                "currency",
                "availability",
                "imageUrl",
                "sourceIdentityScheme",
              ],
              properties: {
                sourceProductKeyHash: {
                  type: "string",
                  pattern: "^[a-f0-9]{64}$",
                },
                sourceVariantKeyHash: {
                  type: "string",
                  pattern: "^[a-f0-9]{64}$",
                },
                sourceOfferKeyHash: {
                  type: "string",
                  pattern: "^[a-f0-9]{64}$",
                },
                displayName: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                },
                categoryName: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                  description:
                    "Название категории поставщика; отсутствует, если поставщик его не передал.",
                },
                unit: {
                  type: "string",
                  enum: ["piece", "gram", "kilogram"],
                },
                supplierUnitMinor: {
                  type: "string",
                  pattern: "^-?(0|[1-9][0-9]*)$",
                },
                currency: {
                  type: "string",
                  const: "RUB",
                },
                availability: {
                  type: "string",
                  enum: ["Available", "Unavailable", "Stopped"],
                },
                imageUrl: {
                  type: ["string", "null"],
                  format: "uri",
                  maxLength: 2048,
                },
                supplierPromotions: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "discountBasisPoints",
                      "minimumWeightRaw",
                      "providerCreatedAt",
                      "providerUpdatedAt",
                    ],
                    properties: {
                      discountBasisPoints: {
                        type: "integer",
                        minimum: 1,
                        maximum: 10000,
                      },
                      minimumWeightRaw: {
                        type: "string",
                        pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$",
                      },
                      providerCreatedAt: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
                      },
                      providerUpdatedAt: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
                      },
                    },
                  },
                },
                grindOptions: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["sourceGrindKeyHash", "displayName"],
                    properties: {
                      sourceGrindKeyHash: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      displayName: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                    },
                  },
                },
                sourceIdentityScheme: {
                  type: "string",
                  const: "hmac-sha256-v1",
                },
              },
            },
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "streamVersion",
          "recordType",
          "snapshotRef",
          "batchCount",
          "productCount",
          "variantCount",
          "offerCount",
          "contentHash",
          "completedAt",
        ],
        properties: {
          streamVersion: {
            const: "1",
          },
          recordType: {
            const: "snapshot-completed",
          },
          snapshotRef: {
            type: "string",
            pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          batchCount: {
            type: "integer",
            minimum: 0,
          },
          productCount: {
            type: "integer",
            minimum: 0,
          },
          variantCount: {
            type: "integer",
            minimum: 0,
          },
          offerCount: {
            type: "integer",
            minimum: 0,
          },
          contentHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          completedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "streamVersion",
          "recordType",
          "snapshotRef",
          "code",
          "failedAt",
        ],
        properties: {
          streamVersion: {
            const: "1",
          },
          recordType: {
            const: "snapshot-failed",
          },
          snapshotRef: {
            type: "string",
            pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          code: {
            type: "string",
            enum: [
              "PROVIDER_UNAVAILABLE",
              "PROVIDER_TIMEOUT",
              "INVALID_STREAM",
              "BATCH_HASH_CONFLICT",
              "SOURCE_IDENTITY_COLLISION",
            ],
          },
          failedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
          },
        },
      },
    ],
  },
  AromaOfferBindingRequest: {
    type: "object",
    additionalProperties: false,
    required: [
      "offerRef",
      "supplierRef",
      "snapshotRef",
      "sourceIdentityScheme",
      "sourceOfferKeyHash",
    ],
    properties: {
      offerRef: {
        type: "string",
        pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      supplierRef: {
        type: "string",
        pattern: "^sup_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      snapshotRef: {
        type: "string",
        pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      sourceIdentityScheme: {
        type: "string",
        const: "hmac-sha256-v1",
      },
      sourceOfferKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
  },
  AromaOfferBindingResponse: {
    type: "object",
    additionalProperties: false,
    required: [
      "offerRef",
      "supplierRef",
      "sourceIdentityScheme",
      "sourceOfferKeyHash",
      "firstSnapshotRef",
      "state",
    ],
    properties: {
      offerRef: {
        type: "string",
        pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      supplierRef: {
        type: "string",
        pattern: "^sup_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      sourceIdentityScheme: {
        type: "string",
        const: "hmac-sha256-v1",
      },
      sourceOfferKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      firstSnapshotRef: {
        type: "string",
        pattern: "^snp_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      state: {
        const: "Bound",
      },
    },
  },
  AromaMutationResponse: {
    type: "object",
    additionalProperties: false,
    required: ["operationRef", "cartScopeRef", "offerRef", "state"],
    properties: {
      operationRef: {
        type: "string",
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      cartScopeRef: {
        type: "string",
        const: "aroma-primary",
      },
      offerRef: {
        type: "string",
        pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      sourceGrindKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      state: {
        const: "Acknowledged",
      },
    },
  },
  AromaCartSnapshotReadRequest: {
    type: "object",
    additionalProperties: false,
    required: ["cartScopeRef"],
    properties: {
      cartScopeRef: {
        type: "string",
        const: "aroma-primary",
      },
    },
  },
  AromaCartSnapshot: {
    type: "object",
    additionalProperties: false,
    required: [
      "cartScopeRef",
      "providerSnapshotRef",
      "capturedAt",
      "cartFingerprint",
      "lines",
    ],
    properties: {
      cartScopeRef: {
        type: "string",
        const: "aroma-primary",
      },
      providerSnapshotRef: {
        type: "string",
        minLength: 1,
        maxLength: 256,
      },
      capturedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
      },
      cartFingerprint: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      lines: {
        type: "array",
        maxItems: 10000,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["offerRef", "quantity"],
          properties: {
            offerRef: {
              type: "string",
              pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
            },
            quantity: {
              type: "string",
              pattern:
                "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$",
            },
            sourceGrindKeyHash: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
            },
          },
        },
      },
    },
  },
  AromaSetQuantityRequest: {
    type: "object",
    additionalProperties: false,
    required: ["operationRef", "cartScopeRef", "quantity"],
    properties: {
      operationRef: {
        type: "string",
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      cartScopeRef: {
        type: "string",
        const: "aroma-primary",
      },
      quantity: {
        type: "string",
        pattern: "^(?:[1-9][0-9]*)(?:\\.[0-9]+)?$|^0\\.(?!0+$)[0-9]+$",
      },
      sourceGrindKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
  },
  AromaRemoveLineRequest: {
    type: "object",
    additionalProperties: false,
    required: ["operationRef", "cartScopeRef"],
    properties: {
      operationRef: {
        type: "string",
        pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      cartScopeRef: {
        type: "string",
        const: "aroma-primary",
      },
      sourceGrindKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
  },
  PricingQuoteVerifyRequest: {
    type: "object",
    additionalProperties: false,
    required: [
      "quoteRef",
      "hash",
      "customerRef",
      "quoteLineNumber",
      "productRef",
      "variantRef",
      "quantity",
    ],
    properties: {
      quoteRef: {
        type: "string",
        pattern: "^prq_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      hash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      customerRef: {
        type: "string",
        pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      quoteLineNumber: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
      productRef: {
        type: "string",
        pattern: "^prd_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      variantRef: {
        type: "string",
        pattern: "^var_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      quantity: {
        type: "string",
        pattern:
          "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$",
      },
      sourceGrindKeyHash: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
  },
  PricingQuoteVerificationResponse: {
    type: "object",
    additionalProperties: false,
    required: [
      "valid",
      "quoteRef",
      "policyVersionRef",
      "catalogSnapshotRevision",
      "customerRef",
      "expiresAt",
      "currency",
      "line",
    ],
    properties: {
      valid: {
        const: true,
      },
      quoteRef: {
        type: "string",
        pattern: "^prq_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      policyVersionRef: {
        type: "string",
        pattern: "^pvr_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      catalogSnapshotRevision: {
        type: "string",
        pattern: "^(0|[1-9][0-9]*)$",
      },
      customerRef: {
        type: "string",
        pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
      },
      expiresAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$",
      },
      currency: {
        type: "string",
        const: "RUB",
      },
      line: {
        type: "object",
        additionalProperties: false,
        dependentRequired: {
          sourceGrindKeyHash: ["grindDisplayName"],
          grindDisplayName: ["sourceGrindKeyHash"],
        },
        required: [
          "lineNumber",
          "productRef",
          "variantRef",
          "productDisplayName",
          "offerRef",
          "mappingRevision",
          "quantity",
          "unit",
          "supplierUnitMinor",
          "unitMinor",
          "lineTotalMinor",
          "currency",
          "internalProofHash",
        ],
        properties: {
          lineNumber: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          productRef: {
            type: "string",
            pattern: "^prd_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          variantRef: {
            type: "string",
            pattern: "^var_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          productDisplayName: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          offerRef: {
            type: "string",
            pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$",
          },
          mappingRevision: {
            type: "string",
            pattern: "^(0|[1-9][0-9]*)$",
          },
          quantity: {
            type: "string",
            pattern:
              "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$",
          },
          unit: {
            type: "string",
            enum: ["piece", "gram", "kilogram"],
          },
          supplierUnitMinor: {
            type: "string",
            pattern: "^-?(0|[1-9][0-9]*)$",
          },
          unitMinor: {
            type: "string",
            pattern: "^-?(0|[1-9][0-9]*)$",
          },
          lineTotalMinor: {
            type: "string",
            pattern: "^-?(0|[1-9][0-9]*)$",
          },
          currency: {
            type: "string",
            const: "RUB",
          },
          internalProofHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          sourceGrindKeyHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          grindDisplayName: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
        },
      },
    },
  },
} as const;

export const internalV1ParameterSchemas = {
  CustomerRef: {
    type: "string",
    pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$",
  },
} as const;
