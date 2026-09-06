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

export const internalV1ParameterSchemas = {
  "CustomerRef": {
    "type": "string",
    "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
  }
} as const;
