// This file is auto-generated from contracts/openapi/client-v1.yaml.

export const clientV1Schemas = {
  "CustomerAddress": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "line1",
      "city",
      "countryCode"
    ],
    "properties": {
      "addressRef": {
        "type": "string",
        "pattern": "^adr_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "line1": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "line2": {
        "type": "string",
        "maxLength": 200
      },
      "city": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "postalCode": {
        "type": "string",
        "maxLength": 32
      },
      "countryCode": {
        "type": "string",
        "pattern": "^[A-Z]{2}$",
        "const": "RU"
      }
    }
  },
  "CustomerCreateRequest": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "displayName",
          "phone"
        ],
        "properties": {
          "displayName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "phone": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "email": {
            "type": "string",
            "format": "email",
            "maxLength": 254
          },
          "address": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "line1",
              "city",
              "countryCode"
            ],
            "properties": {
              "addressRef": {
                "type": "string",
                "pattern": "^adr_[0-9A-HJKMNP-TV-Z]{26}$"
              },
              "line1": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "line2": {
                "type": "string",
                "maxLength": 200
              },
              "city": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100
              },
              "postalCode": {
                "type": "string",
                "maxLength": 32
              },
              "countryCode": {
                "type": "string",
                "pattern": "^[A-Z]{2}$",
                "const": "RU"
              }
            }
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "displayName",
          "email"
        ],
        "properties": {
          "displayName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "phone": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "email": {
            "type": "string",
            "format": "email",
            "maxLength": 254
          },
          "address": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "line1",
              "city",
              "countryCode"
            ],
            "properties": {
              "addressRef": {
                "type": "string",
                "pattern": "^adr_[0-9A-HJKMNP-TV-Z]{26}$"
              },
              "line1": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "line2": {
                "type": "string",
                "maxLength": 200
              },
              "city": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100
              },
              "postalCode": {
                "type": "string",
                "maxLength": 32
              },
              "countryCode": {
                "type": "string",
                "pattern": "^[A-Z]{2}$",
                "const": "RU"
              }
            }
          }
        }
      }
    ]
  },
  "CustomerResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "customerRef",
      "version",
      "displayName",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "version": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "phone": {
        "type": "string",
        "pattern": "^\\+[1-9][0-9]{7,14}$"
      },
      "email": {
        "type": "string",
        "format": "email",
        "maxLength": 254
      },
      "address": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "line1",
          "city",
          "countryCode"
        ],
        "properties": {
          "addressRef": {
            "type": "string",
            "pattern": "^adr_[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "line1": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "line2": {
            "type": "string",
            "maxLength": 200
          },
          "city": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "postalCode": {
            "type": "string",
            "maxLength": 32
          },
          "countryCode": {
            "type": "string",
            "pattern": "^[A-Z]{2}$",
            "const": "RU"
          }
        }
      },
      "createdAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      }
    }
  },
  "CustomerSummary": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "customerRef",
      "version",
      "displayName"
    ],
    "properties": {
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "version": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "phone": {
        "type": "string",
        "maxLength": 32
      },
      "email": {
        "type": "string",
        "maxLength": 254
      }
    }
  },
  "CustomerSearchResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items",
      "nextCursor"
    ],
    "properties": {
      "items": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "customerRef",
            "version",
            "displayName"
          ],
          "properties": {
            "customerRef": {
              "type": "string",
              "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "version": {
              "type": "string",
              "pattern": "^(0|[1-9][0-9]*)$"
            },
            "displayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "phone": {
              "type": "string",
              "maxLength": 32
            },
            "email": {
              "type": "string",
              "maxLength": 254
            }
          }
        }
      },
      "nextCursor": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 2048
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
  "PricingQuoteCreateRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "customerRef",
      "lines"
    ],
    "properties": {
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "lines": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "productRef",
            "variantRef",
            "quantity"
          ],
          "properties": {
            "productRef": {
              "type": "string",
              "pattern": "^prd_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "variantRef": {
              "type": "string",
              "pattern": "^var_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "quantity": {
              "type": "string",
              "pattern": "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$"
            }
          }
        }
      }
    }
  },
  "PricingQuoteResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "quoteRef",
      "policyVersionRef",
      "catalogSnapshotRevision",
      "customerRef",
      "createdAt",
      "expiresAt",
      "currency",
      "lines",
      "totalMinor",
      "hash"
    ],
    "properties": {
      "quoteRef": {
        "type": "string",
        "pattern": "^prq_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "policyVersionRef": {
        "type": "string",
        "pattern": "^pvr_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "catalogSnapshotRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "expiresAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "currency": {
        "type": "string",
        "const": "RUB"
      },
      "lines": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "lineNumber",
            "productRef",
            "variantRef",
            "productDisplayName",
            "quantity",
            "unit",
            "unitMinor",
            "lineTotalMinor"
          ],
          "properties": {
            "lineNumber": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "productRef": {
              "type": "string",
              "pattern": "^prd_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "variantRef": {
              "type": "string",
              "pattern": "^var_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "productDisplayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "quantity": {
              "type": "string",
              "pattern": "^(?:[1-9][0-9]{0,5})(?:\\.[0-9]{1,3})?$|^0\\.(?!0{1,3}$)[0-9]{1,3}$"
            },
            "unit": {
              "type": "string",
              "enum": [
                "piece",
                "gram",
                "kilogram"
              ]
            },
            "unitMinor": {
              "type": "string",
              "pattern": "^-?(0|[1-9][0-9]*)$"
            },
            "lineTotalMinor": {
              "type": "string",
              "pattern": "^-?(0|[1-9][0-9]*)$"
            }
          }
        }
      },
      "totalMinor": {
        "type": "string",
        "pattern": "^-?(0|[1-9][0-9]*)$"
      },
      "hash": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    }
  },
  "QuoteRef": {
    "type": "string",
    "pattern": "^prq_[0-9A-HJKMNP-TV-Z]{26}$"
  }
} as const;

export const clientV1ParameterSchemas = {
  "CustomerQuery": {
    "type": "string",
    "minLength": 2,
    "maxLength": 200
  },
  "PageLimit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50,
    "default": 20
  },
  "CustomerCursor": {
    "type": "string",
    "maxLength": 2048,
    "pattern": "^[A-Za-z0-9_-]*$"
  },
  "Cursor": {
    "type": "string",
    "maxLength": 512,
    "pattern": "^[A-Za-z0-9_-]*$"
  },
  "IdempotencyKey": {
    "type": "string",
    "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
  },
  "ReplayOnly": {
    "type": "boolean",
    "const": true
  }
} as const;
