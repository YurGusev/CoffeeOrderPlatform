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
