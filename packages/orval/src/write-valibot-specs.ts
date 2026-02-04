import {
  type ContextSpec,
  conventionName,
  type GeneratorVerbOptions,
  type NamingConvention,
  type NormalizedOutputOptions,
  type OpenApiSchemaObject,
  pascal,
  upath,
  type WriteSpecBuilder,
} from '@orval/core';
import {
  dereference,
  generateValibotValidationSchemaDefinition,
  parseValibotValidationSchemaDefinition,
} from '@orval/valibot';
import fs from 'fs-extra';

function generateValibotSchemaFileContent(
  header: string,
  schemaName: string,
  schemaContent: string,
): string {
  return `${header}import * as v from 'valibot';

export const ${schemaName} = ${schemaContent}

export type ${schemaName} = v.InferOutput<typeof ${schemaName}>;
`;
}

async function writeValibotSchemaIndex(
  schemasPath: string,
  fileExtension: string,
  header: string,
  schemaNames: string[],
  namingConvention: NamingConvention,
  shouldMergeExisting = false,
) {
  const importFileExtension = fileExtension.replace(/\.ts$/, '');
  const indexPath = upath.join(schemasPath, `index${fileExtension}`);

  let existingExports = '';
  if (shouldMergeExisting && (await fs.pathExists(indexPath))) {
    const existingContent = await fs.readFile(indexPath, 'utf8');
    const headerMatch = /^(\/\*\*[\s\S]*?\*\/\n)?/.exec(existingContent);
    const headerPart = headerMatch ? headerMatch[0] : '';
    existingExports = existingContent.slice(headerPart.length).trim();
  }

  const newExports = schemaNames
    .map((schemaName) => {
      const fileName = conventionName(schemaName, namingConvention);
      return `export * from './${fileName}${importFileExtension}';`;
    })
    .sort()
    .join('\n');

  const allExports = existingExports
    ? `${existingExports}\n${newExports}`
    : newExports;

  const uniqueExports = [...new Set(allExports.split('\n'))]
    .filter((line) => line.trim())
    .sort()
    .join('\n');

  await fs.outputFile(indexPath, `${header}\n${uniqueExports}\n`);
}

export async function writeValibotSchemas(
  builder: WriteSpecBuilder,
  schemasPath: string,
  fileExtension: string,
  header: string,
  output: NormalizedOutputOptions,
) {
  const schemasWithOpenApiDef = builder.schemas.filter((s) => s.schema);

  await Promise.all(
    schemasWithOpenApiDef.map(async (generatorSchema) => {
      const { name, schema: schemaObject } = generatorSchema;

      if (!schemaObject) return;

      const fileName = conventionName(name, output.namingConvention);
      const filePath = upath.join(schemasPath, `${fileName}${fileExtension}`);
      const context: ContextSpec = {
        spec: builder.spec,
        target: builder.target,
        workspace: '',
        output,
      };

      const strict = output.override.valibot.strict.body;

      const dereferencedSchema = dereference(schemaObject, context);

      const definition = generateValibotValidationSchemaDefinition(
        dereferencedSchema,
        context,
        name,
        strict,
        { required: true },
      );

      const parsed = parseValibotValidationSchemaDefinition(
        definition,
        context,
      );

      const schemaContent = parsed.consts
        ? `${parsed.consts}\n${parsed.schema}`
        : parsed.schema;

      const fileContent = generateValibotSchemaFileContent(
        header,
        name,
        schemaContent,
      );

      await fs.outputFile(filePath, fileContent);
    }),
  );

  if (output.indexFiles) {
    const schemaNames = schemasWithOpenApiDef.map((schema) => schema.name);
    await writeValibotSchemaIndex(
      schemasPath,
      fileExtension,
      header,
      schemaNames,
      output.namingConvention,
      false,
    );
  }
}

export async function writeValibotSchemasFromVerbs(
  verbOptions: Record<string, GeneratorVerbOptions>,
  schemasPath: string,
  fileExtension: string,
  header: string,
  output: NormalizedOutputOptions,
  context: ContextSpec,
) {
  const verbOptionsArray = Object.values(verbOptions);
  if (verbOptionsArray.length === 0) return;

  const strict = output.override.valibot.strict.body;

  const generateVerbsSchemas = verbOptionsArray.flatMap((verbOption) => {
    const operation = verbOption.originalOperation;

    const bodySchema =
      operation.requestBody && 'content' in operation.requestBody
        ? operation.requestBody.content['application/json']?.schema
        : undefined;

    const bodySchemas = bodySchema
      ? [
          {
            name: `${pascal(verbOption.operationName)}Body`,
            schema: dereference(bodySchema as OpenApiSchemaObject, context),
          },
        ]
      : [];

    const queryParams = operation.parameters?.filter(
      (p) => 'in' in p && p.in === 'query',
    );

    const queryParamsSchemas =
      queryParams && queryParams.length > 0
        ? [
            {
              name: `${pascal(verbOption.operationName)}Params`,
              schema: {
                type: 'object' as const,
                properties: Object.fromEntries(
                  queryParams
                    .filter((p) => 'schema' in p && p.schema)
                    .map((p) => [
                      p.name,
                      dereference(p.schema as OpenApiSchemaObject, context),
                    ]),
                ),
                required: queryParams
                  .filter((p) => p.required)
                  .map((p) => p.name),
              },
            },
          ]
        : [];

    const headerParams = operation.parameters?.filter(
      (p) => 'in' in p && p.in === 'header',
    );

    const headerParamsSchemas =
      headerParams && headerParams.length > 0
        ? [
            {
              name: `${pascal(verbOption.operationName)}Headers`,
              schema: {
                type: 'object' as const,
                properties: Object.fromEntries(
                  headerParams
                    .filter((p) => 'schema' in p && p.schema)
                    .map((p) => [
                      p.name,
                      dereference(p.schema as OpenApiSchemaObject, context),
                    ]),
                ),
                required: headerParams
                  .filter((p) => p.required)
                  .map((p) => p.name),
              },
            },
          ]
        : [];

    return [...bodySchemas, ...queryParamsSchemas, ...headerParamsSchemas];
  });

  await Promise.all(
    generateVerbsSchemas.map(async ({ name, schema }) => {
      const fileName = conventionName(name, output.namingConvention);
      const filePath = upath.join(schemasPath, `${fileName}${fileExtension}`);

      const definition = generateValibotValidationSchemaDefinition(
        schema,
        context,
        name,
        strict,
        { required: true },
      );

      const parsed = parseValibotValidationSchemaDefinition(
        definition,
        context,
      );

      const schemaContent = parsed.consts
        ? `${parsed.consts}\n${parsed.schema}`
        : parsed.schema;

      const fileContent = generateValibotSchemaFileContent(
        header,
        name,
        schemaContent,
      );

      await fs.outputFile(filePath, fileContent);
    }),
  );

  if (output.indexFiles && generateVerbsSchemas.length > 0) {
    const schemaNames = generateVerbsSchemas.map((s) => s.name);
    await writeValibotSchemaIndex(
      schemasPath,
      fileExtension,
      header,
      schemaNames,
      output.namingConvention,
      true,
    );
  }
}
