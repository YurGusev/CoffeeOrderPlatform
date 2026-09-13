// This file is auto-generated from contracts/openapi/internal-v1.yaml.

export const internalV1Schemas = {
  "CustomerOrderInput": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "customerRef",
      "customerVersion",
      "displayName",
      "state"
    ],
    "properties": {
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "customerVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "state": {
        "type": "string",
        "enum": [
          "Active",
          "Inactive"
        ]
      }
    }
  },
  "CustomerRef": {
    "type": "string",
    "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
  },
  "ProblemDetails": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "type",
      "title",
      "status",
      "code",
      "detail",
      "instance",
      "correlationId",
      "errors"
    ],
    "properties": {
      "type": {
        "type": "string",
        "format": "uri-reference",
        "pattern": "^(?!(?![A-Za-z][A-Za-z0-9+\\-.]*:)[^/?#]*:)(?:[A-Za-z][A-Za-z0-9+\\-.]*:)?(?:\\/\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9A-Fa-f]{1,4}:){6}|::(?:[0-9A-Fa-f]{1,4}:){5}|(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,1}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){3}|(?:(?:[0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){2}|(?:(?:[0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}:|(?:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})?::)(?:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|(?:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})?::)|[Vv][0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~!$&'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)|(?:[A-Za-z0-9\\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::\\d*)?(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*|\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?|(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?(?:\\?(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$",
        "minLength": 1,
        "maxLength": 2048
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "status": {
        "type": "integer",
        "minimum": 400,
        "maximum": 599
      },
      "code": {
        "type": "string",
        "pattern": "^[A-Z][A-Z0-9_]{0,63}$"
      },
      "detail": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "instance": {
        "type": "string",
        "format": "uri-reference",
        "pattern": "^(?!(?![A-Za-z][A-Za-z0-9+\\-.]*:)[^/?#]*:)(?:[A-Za-z][A-Za-z0-9+\\-.]*:)?(?:\\/\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*@)?(?:\\[(?:(?:(?:(?:[0-9A-Fa-f]{1,4}:){6}|::(?:[0-9A-Fa-f]{1,4}:){5}|(?:[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,1}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){3}|(?:(?:[0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})?::(?:[0-9A-Fa-f]{1,4}:){2}|(?:(?:[0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}:|(?:(?:[0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})?::)(?:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?))|(?:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})?::[0-9A-Fa-f]{1,4}|(?:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})?::)|[Vv][0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~!$&'()*+,;=:]+)\\]|(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)|(?:[A-Za-z0-9\\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*)(?::\\d*)?(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*|\\/(?:(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?|(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+(?:\\/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*)?(?:\\?(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$",
        "minLength": 1,
        "maxLength": 2048
      },
      "correlationId": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      },
      "errors": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "message"
          ],
          "properties": {
            "code": {
              "type": "string",
              "pattern": "^[A-Z][A-Z0-9_]{0,63}$"
            },
            "message": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "field": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            }
          }
        }
      }
    }
  },
  "AromaOfferBindingRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "offerRef",
      "supplierRef",
      "snapshotRef",
      "sourceIdentityScheme",
      "sourceOfferKeyHash"
    ],
    "properties": {
      "offerRef": {
        "type": "string",
        "pattern": "^off_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "supplierRef": {
        "type": "string",
        "pattern": "^sup_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "snapshotRef": {
        "type": "string",
        "pattern": "^snp_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "sourceIdentityScheme": {
        "type": "string",
        "const": "hmac-sha256-v1"
      },
      "sourceOfferKeyHash": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    }
  },
  "AromaOfferBindingResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "offerRef",
      "supplierRef",
      "sourceIdentityScheme",
      "sourceOfferKeyHash",
      "firstSnapshotRef",
      "state"
    ],
    "properties": {
      "offerRef": {
        "type": "string",
        "pattern": "^off_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "supplierRef": {
        "type": "string",
        "pattern": "^sup_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "sourceIdentityScheme": {
        "type": "string",
        "const": "hmac-sha256-v1"
      },
      "sourceOfferKeyHash": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "firstSnapshotRef": {
        "type": "string",
        "pattern": "^snp_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "state": {
        "const": "Bound"
      }
    }
  },
  "AromaMutationResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operationRef",
      "cartScopeRef",
      "offerRef",
      "state"
    ],
    "properties": {
      "operationRef": {
        "type": "string",
        "pattern": "^op_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "cartScopeRef": {
        "type": "string",
        "const": "aroma-primary"
      },
      "offerRef": {
        "type": "string",
        "pattern": "^off_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "state": {
        "const": "Acknowledged"
      }
    }
  },
  "AromaCartSnapshotReadRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "cartScopeRef"
    ],
    "properties": {
      "cartScopeRef": {
        "type": "string",
        "const": "aroma-primary"
      }
    }
  },
  "AromaCartSnapshot": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "cartScopeRef",
      "providerSnapshotRef",
      "capturedAt",
      "cartFingerprint",
      "lines"
    ],
    "properties": {
      "cartScopeRef": {
        "type": "string",
        "const": "aroma-primary"
      },
      "providerSnapshotRef": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "capturedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "cartFingerprint": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "lines": {
        "type": "array",
        "maxItems": 10000,
        "uniqueItems": true,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "offerRef",
            "quantity"
          ],
          "properties": {
            "offerRef": {
              "type": "string",
              "pattern": "^off_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "quantity": {
              "type": "string",
              "pattern": "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$"
            }
          }
        }
      }
    }
  }
} as const;

export const internalV1ParameterSchemas = {
  "CustomerRef": {
    "type": "string",
    "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
  }
} as const;
