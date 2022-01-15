/*
* schema.ts
*
* JSON Schema core definitions
*
* Copyright (C) 2021 by RStudio, PBC
*
*/

// deno-lint-ignore no-explicit-any
export type Schema = any;

export interface Completion {
  display: string;
  type: "key" | "value";
  value: string;
  description: string;
  // deno-lint-ignore camelcase
  suggest_on_accept: boolean;
  
  // `schema` stores the concrete schema that yielded the completion.
  // We need to carry it explicitly because of combinators like oneOf
  schema?: Schema;

  // the manually-generated documentation for the completion, if it exists
  documentation?: string;
}

export function schemaType(schema: Schema) {
  const t = schema.type;
  if (t) {
    return t;
  }
  if (schema.anyOf) {
    return "anyOf";
  }
  if (schema.oneOf) {
    return "oneOf";
  }
  if (schema.allOf) {
    return "allOf";
  }
  if (schema.enum) {
    return "enum";
  }
  return "any";
}

export function schemaExhaustiveCompletions(schema: Schema) {
  switch (schemaType(schema)) {
    case "anyOf":
      return schema.anyOf.every(schemaExhaustiveCompletions);
    case "oneOf":
      return schema.oneOf.every(schemaExhaustiveCompletions);
    case "allOf":
      return schema.allOf.every(schemaExhaustiveCompletions);
    case "array":
      return true;
    case "object":
      return true;
    default:
      return schema.exhaustiveCompletions || false;
  }
}

export function schemaCompletions(schema: Schema): Completion[] {
  // FIXME this is slightly inefficient since recursions call
  // normalize() multiple times

  // deno-lint-ignore no-explicit-any
  const normalize = (completions: any) => {
    // deno-lint-ignore no-explicit-any
    const result = (completions || []).map((c: any) => {
      if (typeof c === "string") {
        return {
          type: "value",
          display: c,
          value: c,
          description: "",
          suggest_on_accept: false,
          schema,
        };
      }
      return {
        ...c,
        schema,
      };
    });
    return result;
  };

  if (schema.completions && schema.completions.length) {
    return normalize(schema.completions);
  }

  switch (schemaType(schema)) {
    case "array":
      if (schema.items) {
        return schemaCompletions(schema.items);
      } else {
        return [];
      }
    case "anyOf":
      return schema.anyOf.map(schemaCompletions).flat();
    case "oneOf":
      return schema.oneOf.map(schemaCompletions).flat();
    case "allOf":
      return schema.allOf.map(schemaCompletions).flat();
    default:
      return [];
  }
}

export function walkSchema<T>(schema: Schema, f: (a: Schema) => T) {
  f(schema);
  const t = schemaType(schema);
  switch (t) {
    case "array":
      if (schema.items) {
        walkSchema(schema.items, f);
      }
      break;
    case "anyOf":
      for (const s of schema.anyOf) {
        walkSchema(s, f);
      }
      break;
    case "oneOf":
      for (const s of schema.oneOf) {
        walkSchema(s, f);
      }
      break;
    case "allOf":
      for (const s of schema.allOf) {
        walkSchema(s, f);
      }
      break;
    case "object":
      if (schema.properties) {
        for (const key of Object.getOwnPropertyNames(schema.properties)) {
          const s = schema.properties[key];
          walkSchema(s, f);
        }
      }
      if (schema.patternProperties) {
        for (const key of Object.getOwnPropertyNames(schema.patternProperties)) {
          const s = schema.patternProperties[key];
          walkSchema(s, f);
        }
      }
      if (schema.additionalProperties) {
        walkSchema(schema.additionalProperties, f);
      }
      break;
    // case "boolean":
    // case "null":
    // case "number":
    // case "any":
    // case "enum":
    // case "string":
    //   break;
    // default:
    //   log(`Skipping walk on schema of type ${t}`);
  }
}

/**
* normalizeSchema takes our version of a "json schema" (which includes
* extra fields for autocomplete etc) and builds an actual JSON Schema
* object that passes ajv's strict mode.
*/

export function normalizeSchema(schema: Schema): Schema {
  // FIXME this deep copy can probably be made more efficient
  const result = JSON.parse(JSON.stringify(schema));

  walkSchema(result, (schema) => {
    if (schema.completions) {
      delete schema.completions;
    }
    if (schema.exhaustiveCompletions) {
      delete schema.exhaustiveCompletions;
    }
    if (schema.documentation) {
      delete schema.documentation;
    }
    if (schema.tags) {
      delete schema.tags;
    }
  });

  return result;
}

const definitionsObject: Record<string, Schema> = {};

export function hasSchemaDefinition(key: string): boolean
{
  return definitionsObject[key] !== undefined;
}

export function getSchemaDefinition(key: string): Schema
{
  if (definitionsObject[key] === undefined) {
    throw new Error(`Internal Error: Schema ${key} not found.`);
  }
  return definitionsObject[key];
}

export function setSchemaDefinition(schema: Schema)
{
  if (definitionsObject[schema.$id] === undefined) {
    definitionsObject[schema.$id] = schema;
  }
}

export function getSchemaDefinitionsObject(): Record<string, Schema>
{
  return Object.assign({}, definitionsObject);
}

export function expandAliasesFrom(lst: string[], defs: Record<string, string[]>): string[]
{
  const aliases = defs;
  const result = [];
  
  lst = lst.slice();
  for (let i = 0; i < lst.length; ++i) {
    const el = lst[i];
    if (el.startsWith("$")) {
      const v = aliases[el.slice(1)];
      if (v === undefined) {
        throw new Error(`Internal Error: ${el} doesn't have an entry in the aliases map`);
      }
      lst.push(...v);
    } else {
      result.push(el);
    }
  }
  return result;
}
