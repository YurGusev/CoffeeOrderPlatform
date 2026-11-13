// This file is auto-generated from contracts/openapi/edge-auth-v1.yaml.

export const edgeAuthV1Schemas = {
  BrowserSession: {
    type: "object",
    additionalProperties: false,
    required: ["actorRef", "expiresAt"],
    properties: {
      actorRef: {
        type: "string",
        minLength: 1,
      },
      expiresAt: {
        type: "string",
        format: "date-time",
      },
    },
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
      },
      title: {
        type: "string",
      },
      status: {
        type: "integer",
        minimum: 400,
      },
      code: {
        type: "string",
      },
      detail: {
        type: "string",
      },
      instance: {
        type: "string",
      },
      correlationId: {
        type: "string",
      },
      errors: {
        type: "array",
        items: {
          type: "object",
        },
      },
    },
  },
} as const;

export const edgeAuthV1ParameterSchemas = {} as const;
