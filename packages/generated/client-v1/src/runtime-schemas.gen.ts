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
  "CatalogProductSummary": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "productRef",
      "variantRef",
      "displayName",
      "unit",
      "availability",
      "mappingAvailable"
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
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "categoryName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "Название категории поставщика; отсутствует, если поставщик его не передал."
      },
      "unit": {
        "type": "string",
        "enum": [
          "piece",
          "gram",
          "kilogram"
        ]
      },
      "availability": {
        "type": "string",
        "enum": [
          "Available",
          "Unavailable",
          "Stopped"
        ]
      },
      "mappingAvailable": {
        "type": "boolean"
      },
      "imageUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "prices": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "supplierUnitMinor",
          "saleUnitMinor",
          "currency"
        ],
        "properties": {
          "supplierUnitMinor": {
            "allOf": [
              {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)$"
              },
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]{0,18})$"
              }
            ]
          },
          "saleUnitMinor": {
            "allOf": [
              {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)$"
              },
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]{0,18})$"
              }
            ]
          },
          "currency": {
            "type": "string",
            "const": "RUB"
          }
        }
      },
      "supplierPromotions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "description": "Правило поставщика из активного снимка. Даты являются фактами провайдера, а не сроком действия; minimumWeightRaw сохраняется без предположения о единице.",
          "required": [
            "discountBasisPoints",
            "minimumWeightRaw",
            "providerCreatedAt",
            "providerUpdatedAt"
          ],
          "properties": {
            "discountBasisPoints": {
              "type": "integer",
              "minimum": 1,
              "maximum": 10000
            },
            "minimumWeightRaw": {
              "type": "string",
              "pattern": "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$"
            },
            "providerCreatedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
            },
            "providerUpdatedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
            }
          }
        }
      },
      "grindOptions": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sourceGrindKeyHash",
            "displayName"
          ],
          "properties": {
            "sourceGrindKeyHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "displayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            }
          }
        }
      }
    }
  },
  "CatalogSearchResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "snapshotRevision",
      "items",
      "nextCursor"
    ],
    "properties": {
      "snapshotRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "items": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "productRef",
            "variantRef",
            "displayName",
            "unit",
            "availability",
            "mappingAvailable"
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
            "displayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "categoryName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Название категории поставщика; отсутствует, если поставщик его не передал."
            },
            "unit": {
              "type": "string",
              "enum": [
                "piece",
                "gram",
                "kilogram"
              ]
            },
            "availability": {
              "type": "string",
              "enum": [
                "Available",
                "Unavailable",
                "Stopped"
              ]
            },
            "mappingAvailable": {
              "type": "boolean"
            },
            "imageUrl": {
              "type": "string",
              "format": "uri",
              "maxLength": 2048
            },
            "prices": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "supplierUnitMinor",
                "saleUnitMinor",
                "currency"
              ],
              "properties": {
                "supplierUnitMinor": {
                  "allOf": [
                    {
                      "type": "string",
                      "pattern": "^-?(0|[1-9][0-9]*)$"
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,18})$"
                    }
                  ]
                },
                "saleUnitMinor": {
                  "allOf": [
                    {
                      "type": "string",
                      "pattern": "^-?(0|[1-9][0-9]*)$"
                    },
                    {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,18})$"
                    }
                  ]
                },
                "currency": {
                  "type": "string",
                  "const": "RUB"
                }
              }
            },
            "supplierPromotions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "description": "Правило поставщика из активного снимка. Даты являются фактами провайдера, а не сроком действия; minimumWeightRaw сохраняется без предположения о единице.",
                "required": [
                  "discountBasisPoints",
                  "minimumWeightRaw",
                  "providerCreatedAt",
                  "providerUpdatedAt"
                ],
                "properties": {
                  "discountBasisPoints": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10000
                  },
                  "minimumWeightRaw": {
                    "type": "string",
                    "pattern": "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$"
                  },
                  "providerCreatedAt": {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
                  },
                  "providerUpdatedAt": {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
                  }
                }
              }
            },
            "grindOptions": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "sourceGrindKeyHash",
                  "displayName"
                ],
                "properties": {
                  "sourceGrindKeyHash": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "displayName": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  }
                }
              }
            }
          }
        }
      },
      "policyVersionRef": {
        "type": "string",
        "pattern": "^pvr_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "nextCursor": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 512
      }
    }
  },
  "CatalogPrices": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "supplierUnitMinor",
      "saleUnitMinor",
      "currency"
    ],
    "properties": {
      "supplierUnitMinor": {
        "allOf": [
          {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)$"
          },
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]{0,18})$"
          }
        ]
      },
      "saleUnitMinor": {
        "allOf": [
          {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)$"
          },
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]{0,18})$"
          }
        ]
      },
      "currency": {
        "type": "string",
        "const": "RUB"
      }
    }
  },
  "CatalogSupplierPromotion": {
    "type": "object",
    "additionalProperties": false,
    "description": "Правило поставщика из активного снимка. Даты являются фактами провайдера, а не сроком действия; minimumWeightRaw сохраняется без предположения о единице.",
    "required": [
      "discountBasisPoints",
      "minimumWeightRaw",
      "providerCreatedAt",
      "providerUpdatedAt"
    ],
    "properties": {
      "discountBasisPoints": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "minimumWeightRaw": {
        "type": "string",
        "pattern": "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$"
      },
      "providerCreatedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "providerUpdatedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      }
    }
  },
  "PricingPreviewRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "snapshotRevision",
      "items"
    ],
    "properties": {
      "snapshotRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "items": {
        "type": "array",
        "maxItems": 50,
        "uniqueItems": true,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "productRef",
            "variantRef"
          ],
          "properties": {
            "productRef": {
              "type": "string",
              "pattern": "^prd_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "variantRef": {
              "type": "string",
              "pattern": "^var_[0-9A-HJKMNP-TV-Z]{26}$"
            }
          }
        }
      }
    }
  },
  "PricingPreviewResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "snapshotRevision",
      "policyVersionRef",
      "items"
    ],
    "properties": {
      "snapshotRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "policyVersionRef": {
        "type": "string",
        "pattern": "^pvr_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "items": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "productRef",
            "variantRef",
            "unit",
            "supplierUnitMinor",
            "saleUnitMinor",
            "currency"
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
            "unit": {
              "type": "string",
              "enum": [
                "piece",
                "gram",
                "kilogram"
              ]
            },
            "supplierUnitMinor": {
              "allOf": [
                {
                  "type": "string",
                  "pattern": "^-?(0|[1-9][0-9]*)$"
                },
                {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
                }
              ]
            },
            "saleUnitMinor": {
              "allOf": [
                {
                  "type": "string",
                  "pattern": "^-?(0|[1-9][0-9]*)$"
                },
                {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
                }
              ]
            },
            "currency": {
              "type": "string",
              "const": "RUB"
            }
          }
        }
      }
    }
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
            },
            "sourceGrindKeyHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
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
          "dependentRequired": {
            "sourceGrindKeyHash": [
              "grindDisplayName"
            ],
            "grindDisplayName": [
              "sourceGrindKeyHash"
            ]
          },
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
            },
            "sourceGrindKeyHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "grindDisplayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
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
  },
  "OrderDraftCreateRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "customerRef"
    ],
    "properties": {
      "customerRef": {
        "type": "string",
        "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
      }
    }
  },
  "OrderItemPutRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "expectedVersion",
      "productRef",
      "variantRef",
      "quantity",
      "quoteRef",
      "quoteLineNumber",
      "quoteHash"
    ],
    "properties": {
      "expectedVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
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
      },
      "quoteRef": {
        "type": "string",
        "pattern": "^prq_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "quoteLineNumber": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "quoteHash": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "sourceGrindKeyHash": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    }
  },
  "OrderConfirmRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "expectedVersion"
    ],
    "properties": {
      "expectedVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      }
    }
  },
  "ReconciliationRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "expectedVersion",
      "reason"
    ],
    "properties": {
      "expectedVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      }
    }
  },
  "OrderCardResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "orderRef",
      "version",
      "projectionVersion",
      "status",
      "customer",
      "items",
      "pricing",
      "aroma",
      "allowedActions"
    ],
    "properties": {
      "orderRef": {
        "type": "string",
        "pattern": "^ord_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "version": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "projectionVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "status": {
        "type": "string",
        "enum": [
          "Draft",
          "Confirmed"
        ]
      },
      "customer": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "customerRef",
          "displayName"
        ],
        "properties": {
          "customerRef": {
            "type": "string",
            "pattern": "^cus_[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "displayName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        }
      },
      "items": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "dependentRequired": {
            "sourceGrindKeyHash": [
              "grindDisplayName"
            ],
            "grindDisplayName": [
              "sourceGrindKeyHash"
            ]
          },
          "required": [
            "itemRef",
            "linePosition",
            "productRef",
            "variantRef",
            "displayName",
            "quantity",
            "unit",
            "quoteRef",
            "quoteLineNumber",
            "unitMinor",
            "lineTotalMinor"
          ],
          "properties": {
            "itemRef": {
              "type": "string",
              "pattern": "^itm_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "linePosition": {
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
            "displayName": {
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
            "quoteRef": {
              "type": "string",
              "pattern": "^prq_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "quoteLineNumber": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "unitMinor": {
              "type": "string",
              "pattern": "^-?(0|[1-9][0-9]*)$"
            },
            "lineTotalMinor": {
              "type": "string",
              "pattern": "^-?(0|[1-9][0-9]*)$"
            },
            "sourceGrindKeyHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "grindDisplayName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            }
          }
        }
      },
      "pricing": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "totalMinor",
              "currency",
              "quoteProofs"
            ],
            "properties": {
              "totalMinor": {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)$"
              },
              "currency": {
                "type": "string",
                "const": "RUB"
              },
              "quoteProofs": {
                "type": "array",
                "maxItems": 100,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "quoteRef",
                    "hash",
                    "expiresAt"
                  ],
                  "properties": {
                    "quoteRef": {
                      "type": "string",
                      "pattern": "^prq_[0-9A-HJKMNP-TV-Z]{26}$"
                    },
                    "hash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "expiresAt": {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
                    }
                  }
                }
              }
            }
          },
          {
            "type": "null"
          }
        ]
      },
      "aroma": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "state",
          "desiredRevision",
          "observedRevision",
          "blockers"
        ],
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "NotRequested",
              "PendingObservation",
              "OutOfSync",
              "Converging",
              "InSync",
              "Blocked",
              "UnknownOutcome"
            ]
          },
          "desiredRevision": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)$"
          },
          "observedRevision": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)$"
          },
          "lastObservedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "pattern": "Z$"
          },
          "blockers": {
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
                  "enum": [
                    "MAPPING_CHANGED",
                    "MAPPING_MISSING",
                    "MAPPING_STOPPED",
                    "PRODUCT_UNAVAILABLE",
                    "ORDER_STATE_INCONSISTENT",
                    "AROMA_UNKNOWN_OUTCOME",
                    "AROMA_WORKER_INTERRUPTED",
                    "AROMA_OBSERVATION_UNAVAILABLE",
                    "AROMA_OBSERVATION_INVALID",
                    "AROMA_EXTERNAL_CHANGE",
                    "AROMA_QUANTITY_NOT_SUPPORTED",
                    "AROMA_MUTATIONS_DISABLED",
                    "AROMA_MAPPING_NOT_AVAILABLE",
                    "AROMA_OPERATION_UNKNOWN_OUTCOME",
                    "AROMA_VERIFICATION_UNAVAILABLE",
                    "AROMA_VERIFICATION_INVALID",
                    "AROMA_CART_ITEM_NOT_FOUND"
                  ]
                },
                "message": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500
                },
                "productRef": {
                  "type": "string",
                  "pattern": "^prd_[0-9A-HJKMNP-TV-Z]{26}$"
                }
              }
            }
          }
        }
      },
      "allowedActions": {
        "type": "array",
        "uniqueItems": true,
        "items": {
          "type": "string",
          "enum": [
            "edit-items",
            "confirm",
            "request-aroma-reconciliation"
          ]
        }
      }
    }
  },
  "ReconciliationAcceptedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "orderRef",
      "orderVersion",
      "requestedAt",
      "aromaState"
    ],
    "properties": {
      "orderRef": {
        "type": "string",
        "pattern": "^ord_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "orderVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "requestedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      },
      "aromaState": {
        "type": "string",
        "enum": [
          "PendingObservation",
          "OutOfSync",
          "Converging",
          "Blocked",
          "UnknownOutcome"
        ]
      }
    }
  },
  "OrderRef": {
    "type": "string",
    "pattern": "^ord_[0-9A-HJKMNP-TV-Z]{26}$"
  },
  "ItemRef": {
    "type": "string",
    "pattern": "^itm_[0-9A-HJKMNP-TV-Z]{26}$"
  },
  "ProductRef": {
    "type": "string",
    "pattern": "^prd_[0-9A-HJKMNP-TV-Z]{26}$"
  },
  "VariantRef": {
    "type": "string",
    "pattern": "^var_[0-9A-HJKMNP-TV-Z]{26}$"
  },
  "ErrorOrderConfirmationRejected": {
    "allOf": [
      {
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
      {
        "type": "object",
        "properties": {
          "status": {
            "const": 422
          },
          "code": {
            "const": "ORDER_CONFIRMATION_REJECTED"
          }
        }
      }
    ]
  },
  "ErrorOrderEmpty": {
    "allOf": [
      {
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
      {
        "type": "object",
        "properties": {
          "status": {
            "const": 422
          },
          "code": {
            "const": "ORDER_EMPTY"
          }
        }
      }
    ]
  },
  "ErrorOrderDesiredOverflow": {
    "allOf": [
      {
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
      {
        "type": "object",
        "properties": {
          "status": {
            "const": 422
          },
          "code": {
            "const": "ORDER_DESIRED_OVERFLOW"
          }
        }
      }
    ]
  },
  "ErrorOrderItemLimitExceeded": {
    "allOf": [
      {
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
      {
        "type": "object",
        "properties": {
          "status": {
            "const": 409
          },
          "code": {
            "const": "ORDER_ITEM_LIMIT_EXCEEDED"
          }
        }
      }
    ]
  },
  "ErrorOrderQuoteScopeMismatch": {
    "allOf": [
      {
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
      {
        "type": "object",
        "properties": {
          "status": {
            "const": 409
          },
          "code": {
            "const": "ORDER_QUOTE_SCOPE_MISMATCH"
          }
        }
      }
    ]
  },
  "SseResourceInvalidated": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "subjectType",
      "subjectRef",
      "ownerVersion",
      "reason",
      "correlationId"
    ],
    "properties": {
      "subjectType": {
        "const": "order"
      },
      "subjectRef": {
        "type": "string",
        "pattern": "^ord_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "ownerVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)$"
      },
      "reason": {
        "type": "string",
        "enum": [
          "OrderChanged",
          "AromaStateChanged"
        ]
      },
      "correlationId": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      }
    }
  },
  "SseStreamReady": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "connectionId",
      "connectedAt"
    ],
    "properties": {
      "connectionId": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      },
      "connectedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"
      }
    }
  },
  "SseStreamReset": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "reason"
    ],
    "properties": {
      "reason": {
        "const": "REPLAY_UNAVAILABLE"
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
  },
  "IfMatchVersion": {
    "type": "string",
    "pattern": "^(0|[1-9][0-9]*)$"
  }
} as const;
