/*
* definitions.ts
*
* Copyright (C) 2021 by RStudio, PBC
*
*/

import { convertFromYaml } from "./from-yaml.ts";
import { idSchema, refSchema } from "./common.ts";
import { readYaml } from "../yaml.ts";
import { error } from "log/mod.ts";
import { schemaPath } from "./utils.ts";
import { buildSchemaResources } from "./from-yaml.ts";
import {
  addValidatorErrorHandler,
  ValidatorErrorHandlerFunction,
  withValidator,
} from "../lib/yaml-validation/validator-queue.ts";
import {
  getSchemaDefinition,
  hasSchemaDefinition,
  normalizeSchema,
  Schema,
  setSchemaDefinition,
} from "../lib/yaml-validation/schema.ts";

export function defineCached(
  thunk: () => Promise<
    { schema: Schema; errorHandlers: ValidatorErrorHandlerFunction[] }
  >,
  schemaId: string,
): (() => Promise<Schema>) {
  let schema: Schema;

  return async () => {
    // when running on the CLI outside of quarto build-js, these
    // definitions will already exist.
    if (hasSchemaDefinition(schemaId)) {
      schema = getSchemaDefinition(schemaId);
      return refSchema(
        schema!.$id as string,
        (schema!.description as string) || `be a {schema['$id']}`,
      );
    }

    const result = await thunk();
    const { errorHandlers } = result;
    schema = result.schema;
    if (schemaId !== schema!.$id as string) {
      schema = idSchema(schema, schemaId);
    }
    await define(schema);
    for (const fun of errorHandlers) {
      await addValidatorErrorHandler(schema, fun);
    }

    return refSchema(
      schema!.$id as string,
      (schema!.description as string) || `be a {schema['$id']}`,
    );
  };
}

export async function define(schema: Schema) {
  if (!hasSchemaDefinition(schema.$id)) {
    setSchemaDefinition(schema);
    await withValidator(normalizeSchema(schema), async (_validator) => {
    });
  }
}

export async function loadDefaultSchemaDefinitions() {
  await loadSchemaDefinitions(schemaPath("definitions.yml"));
  await buildSchemaResources();
}

export async function loadSchemaDefinitions(file: string) {
  // deno-lint-ignore no-explicit-any
  const yaml = readYaml(file) as any[];

  await Promise.all(yaml.map(async (yamlSchema) => {
    const schema = convertFromYaml(yamlSchema);
    if (schema.$id === undefined) {
      console.log(JSON.stringify(yamlSchema, null, 2));
      error(JSON.stringify(schema, null, 2));
      throw new Error(`Internal error: unnamed schema in definitions`);
    }
    setSchemaDefinition(schema);
    await withValidator(normalizeSchema(schema), async (_validator) => {
    });
  }));
}
