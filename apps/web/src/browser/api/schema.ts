type JsonSchema = Readonly<{
  additionalProperties?: boolean;
  allOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  const?: unknown;
  dependentRequired?: Readonly<Record<string, readonly string[]>>;
  enum?: readonly unknown[];
  format?: string;
  items?: JsonSchema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  oneOf?: readonly JsonSchema[];
  pattern?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  type?: string | readonly string[];
  uniqueItems?: boolean;
}>;

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return valueType(value) === expected;
}

function validate(schema: JsonSchema, value: unknown, path: string): string[] {
  if (schema.allOf) {
    for (const candidate of schema.allOf) {
      const errors = validate(candidate, value, path);
      if (errors.length > 0) return errors;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => validate(candidate, value, path).length === 0)) {
    return [`${path}: значение не соответствует ни одной ветке anyOf`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validate(candidate, value, path).length === 0).length;
    if (matches !== 1) return [`${path}: значение должно соответствовать ровно одной ветке oneOf`];
  }
  if (schema.const !== undefined && value !== schema.const) return [`${path}: ожидалось фиксированное значение`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: значение вне разрешённого enum`];

  const expected = schema.type;
  if (expected) {
    const types = typeof expected === "string" ? [expected] : expected;
    if (!types.some((type) => matchesType(type, value))) return [`${path}: ожидался тип ${types.join("|")}`];
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path}: строка короче minLength`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path}: строка длиннее maxLength`];
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return [`${path}: строка не соответствует pattern`];
    if (schema.format === "date-time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return [`${path}: некорректный date-time`];
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return [`${path}: некорректный email`];
    if (schema.format === "uri") {
      try {
        const parsed = new URL(value);
        if (!parsed.protocol) return [`${path}: некорректный uri`];
      } catch {
        return [`${path}: некорректный uri`];
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: число меньше minimum`];
    if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: число больше maximum`];
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return [`${path}: массив короче minItems`];
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return [`${path}: массив длиннее maxItems`];
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return [`${path}: элементы массива должны быть уникальны`];
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const errors = validate(schema.items, item, `${path}/${index}`);
        if (errors.length > 0) return errors;
      }
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) return [`${path}/${key}: обязательное поле отсутствует`];
    }
    for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (key in record) {
        for (const dependency of dependencies) {
          if (!(dependency in record)) return [`${path}/${dependency}: обязательное поле отсутствует вместе с ${key}`];
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) return [`${path}/${key}: дополнительное поле запрещено`];
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) continue;
      const errors = validate(propertySchema, record[key], `${path}/${key}`);
      if (errors.length > 0) return errors;
    }
  }

  return [];
}

export function assertSchema<T>(schema: unknown, value: unknown, label: string): T {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${label}: runtime schema is unavailable`);
  }
  const errors = validate(schema as JsonSchema, value, "$" );
  if (errors.length > 0) throw new Error(`${label}: ответ не прошёл runtime validation: ${errors.join("; ")}`);
  return value as T;
}
