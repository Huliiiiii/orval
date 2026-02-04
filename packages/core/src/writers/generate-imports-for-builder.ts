import { uniqueBy } from 'remeda';

import type { GeneratorImport, NormalizedOutputOptions } from '../types';
import { conventionName, isObject, upath } from '../utils';

export function generateImportsForBuilder(
  output: NormalizedOutputOptions,
  imports: GeneratorImport[],
  relativeSchemasPath: string,
) {
  const schemaOutputType = isObject(output.schemas)
    ? output.schemas.type
    : null;
  const isSchemaOutput =
    schemaOutputType === 'zod' || schemaOutputType === 'valibot';
  const schemaSuffix = isSchemaOutput ? `.${schemaOutputType}` : '';

  if (!output.indexFiles) {
    return uniqueBy(imports, (x) => x.name).map((i) => {
      const baseName = i.schemaName || i.name;
      const name = conventionName(baseName, output.namingConvention);
      const importExtension = output.fileExtension?.replace(/\.ts$/, '') || '';
      return {
        exports: isSchemaOutput ? [{ ...i, values: true }] : [i],
        dependency: upath.joinSafe(
          relativeSchemasPath,
          `${name}${schemaSuffix}${importExtension}`,
        ),
      };
    });
  } else {
    if (isSchemaOutput) {
      return [
        {
          exports: imports.map((i) => ({ ...i, values: true })),
          dependency: upath.joinSafe(
            relativeSchemasPath,
            `index${schemaSuffix}`,
          ),
        },
      ];
    } else {
      return [{ exports: imports, dependency: relativeSchemasPath }];
    }
  }
}
