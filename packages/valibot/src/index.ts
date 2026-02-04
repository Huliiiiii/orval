import {
  camel,
  type ClientBuilder,
  type ClientGeneratorsBuilder,
  type ContextSpec,
  escape,
  getFormDataFieldFileType,
  getNumberWord,
  getPropertySafe,
  isBoolean,
  isObject,
  isString,
  jsStringEscape,
  type OpenApiParameterObject,
  type OpenApiReferenceObject,
  type OpenApiRequestBodyObject,
  type OpenApiResponseObject,
  type OpenApiSchemaObject,
  pascal,
  resolveRef,
  stringify,
} from '@orval/core';
import { unique } from 'remeda';

const VALIBOT_DEPENDENCIES = [
  {
    exports: [
      {
        default: false,
        name: 'v',
        syntheticDefaultImport: false,
        namespaceImport: true,
        values: true,
      },
    ],
    dependency: 'valibot',
  },
];

export const getValibotDependencies = () => VALIBOT_DEPENDENCIES;

const getObjectFunctionName = (strict: boolean) =>
  strict ? 'strictObject' : 'object';

const getParameterFunctions = (
  strict: boolean,
  parameters: Record<string, any>,
): [string, any][] => [[getObjectFunctionName(strict), parameters]];

/**
 * values that may appear in "type". Equals SchemaObjectType
 */
const possibleSchemaTypes = new Set([
  'integer',
  'number',
  'string',
  'boolean',
  'object',
  'null',
  'array',
]);

const resolveValibotType = (schema: OpenApiSchemaObject) => {
  const schemaTypeValue = schema.type;

  // Handle array of types (OpenAPI 3.1+)
  if (Array.isArray(schemaTypeValue)) {
    const nonNullTypes = schemaTypeValue
      .filter((t) => t !== 'null' && possibleSchemaTypes.has(t))
      .map((t) => t);

    if (nonNullTypes.length > 1) {
      return { multiType: nonNullTypes };
    }

    const type = nonNullTypes[0];
    if (type === 'array' && 'prefixItems' in schema) {
      return 'tuple';
    }

    return type;
  }

  // Handle single type value
  const type = schemaTypeValue;
  if (type === 'array' && 'prefixItems' in schema) {
    return 'tuple';
  }

  return type ?? 'unknown';
};

const constsUniqueCounter: Record<string, number> = {};

export type ValibotValidationSchemaDefinition = {
  functions: [string, any][];
  consts: string[];
};

const removeReadOnlyProperties = (
  schema: OpenApiSchemaObject,
): OpenApiSchemaObject => {
  if (schema.properties) {
    return {
      ...schema,
      properties: Object.entries(schema.properties).reduce<
        Record<string, OpenApiSchemaObject>
      >((acc, [key, value]) => {
        if ('readOnly' in value && value.readOnly) return acc;
        acc[key] = value as OpenApiSchemaObject;
        return acc;
      }, {}),
    };
  }
  if (schema.items && 'properties' in schema.items) {
    return {
      ...schema,
      items: removeReadOnlyProperties(schema.items as OpenApiSchemaObject),
    };
  }
  return schema;
};

export const generateValibotValidationSchemaDefinition = (
  schema: OpenApiSchemaObject | undefined,
  context: ContextSpec,
  name: string,
  strict: boolean,
  rules?: {
    required?: boolean;
    /**
     * Override schemas for properties at THIS level only.
     * Not passed to nested schemas. Used by form-data for file type handling.
     */
    propertyOverrides?: Record<string, ValibotValidationSchemaDefinition>;
  },
): ValibotValidationSchemaDefinition => {
  if (!schema) return { functions: [], consts: [] };

  const consts: string[] = [];
  const constsCounter =
    typeof constsUniqueCounter[name] === 'number'
      ? constsUniqueCounter[name] + 1
      : 0;

  const constsCounterValue = constsCounter
    ? pascal(getNumberWord(constsCounter))
    : '';

  constsUniqueCounter[name] = constsCounter;

  const functions: [string, any][] = [];

  const type = resolveValibotType(schema);
  const required = rules?.required ?? false;
  const nullable =
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    ('nullable' in schema && schema.nullable) ||
    (Array.isArray(schema.type) && schema.type.includes('null'));

  const min = schema.minimum ?? schema.minLength ?? schema.minItems;
  const max = schema.maximum ?? schema.maxLength ?? schema.maxItems;

  let defaultVarName: string | undefined;
  if (schema.default !== undefined) {
    defaultVarName = `${name}Default${constsCounterValue}`;
    let defaultValue: string | undefined;

    const isDateType =
      schema.type === 'string' &&
      (schema.format === 'date' || schema.format === 'date-time') &&
      context.output.override.useDates;

    if (isDateType) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      defaultValue = `new Date("${escape(schema.default)}")`;
    } else if (isObject(schema.default)) {
      const entries = Object.entries(schema.default)
        .map(([key, value]) => {
          if (isString(value)) {
            return `${key}: "${escape(value)}"`;
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          return `${key}: ${stringify(value)}`;
        })
        .join(', ');
      defaultValue = `{ ${entries} }`;
    } else if (isString(schema.default)) {
      defaultValue = `"${escape(schema.default)}"`;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const rawStringified = stringify(schema.default);
      defaultValue = rawStringified === undefined ? 'null' : rawStringified;

      // If the schema is an array with enum items, inject inplace to avoid issues with default values
      const isArrayWithEnumItems =
        Array.isArray(schema.default) &&
        type === 'array' &&
        schema.items &&
        'enum' in schema.items &&
        schema.default.length > 0;

      if (isArrayWithEnumItems) {
        defaultVarName = defaultValue;
        defaultValue = undefined;
      }
    }

    if (defaultValue) {
      consts.push(`export const ${defaultVarName} = ${defaultValue};`);
    }
  }

  // Handle multi-type schemas (OpenAPI 3.1+ type arrays)
  if (typeof type === 'object' && 'multiType' in type) {
    const types = type.multiType;
    functions.push([
      'oneOf',
      types.map((t) =>
        generateValibotValidationSchemaDefinition(
          { ...schema, type: t },
          context,
          name,
          strict,
          { required: true },
        ),
      ),
    ]);

    if (!required && nullable) {
      functions.push(['nullish', undefined]);
    } else if (nullable) {
      functions.push(['nullable', undefined]);
    } else if (!required) {
      functions.push(['optional', undefined]);
    }

    if (schema.description) {
      functions.push(['description', `'${jsStringEscape(schema.description)}'`]);
    }

    return { functions, consts: unique(consts) };
  }

  // Handle allOf/oneOf/anyOf BEFORE processing by type
  let skipSwitchStatement = false;
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    const separator = schema.allOf ? 'allOf' : schema.oneOf ? 'oneOf' : 'anyOf';

    const schemas = (schema.allOf ?? schema.oneOf ?? schema.anyOf) as (
      | OpenApiSchemaObject
      | OpenApiReferenceObject
    )[];

    const baseSchemas = schemas.map((s, index) =>
      generateValibotValidationSchemaDefinition(
        s as OpenApiSchemaObject,
        context,
        `${camel(name)}${pascal(getNumberWord(index + 1))}`,
        strict,
        { required: true },
      ),
    );

    // Keep same behavior as zod generator: if common properties are present, intersect them.
    if ((schema.allOf || schema.oneOf || schema.anyOf) && schema.properties) {
      const additionalPropertiesSchema = {
        properties: schema.properties,
        required: schema.required,
        additionalProperties: schema.additionalProperties,
        type: schema.type,
      } as OpenApiSchemaObject;

      const additionalIndex = baseSchemas.length + 1;
      const additionalPropertiesDefinition =
        generateValibotValidationSchemaDefinition(
          additionalPropertiesSchema,
          context,
          `${camel(name)}${pascal(getNumberWord(additionalIndex))}`,
          strict,
          { required: true },
        );

      if (schema.oneOf || schema.anyOf) {
        functions.push([
          'allOf',
          [
            { functions: [[separator, baseSchemas]], consts: [] },
            additionalPropertiesDefinition,
          ],
        ]);
      } else {
        baseSchemas.push(additionalPropertiesDefinition);
        functions.push([separator, baseSchemas]);
      }
    } else {
      functions.push([separator, baseSchemas]);
    }

    skipSwitchStatement = true;
  }

  if (!skipSwitchStatement) {
    switch (type) {
      case 'tuple': {
        if ('prefixItems' in schema) {
          const schema31 = schema as OpenApiSchemaObject;

          if (schema31.prefixItems && schema31.prefixItems.length > 0) {
            functions.push([
              'tuple',
              schema31.prefixItems.map((item, idx) =>
                generateValibotValidationSchemaDefinition(
                  dereference(item as any, context),
                  context,
                  camel(`${name}-${idx}`),
                  strict,
                  { required: true },
                ),
              ),
            ]);
            break;
          }
        }

        functions.push(['array', { functions: [['unknown', undefined]], consts: [] }]);
        break;
      }

      case 'array': {
        const itemSchema =
          schema.items && isObject(schema.items)
            ? generateValibotValidationSchemaDefinition(
                dereference(schema.items as any, context),
                context,
                camel(`${name}-item`),
                strict,
                { required: true },
              )
            : { functions: [['unknown', undefined]], consts: [] };

        functions.push(['array', itemSchema]);
        break;
      }

      case 'object': {
        if (schema.properties) {
          functions.push([
            getObjectFunctionName(strict),
            Object.keys(schema.properties)
              .map((key) => ({
                [key]:
                  rules?.propertyOverrides?.[key] ??
                  generateValibotValidationSchemaDefinition(
                    schema.properties?.[key] as OpenApiSchemaObject | undefined,
                    context,
                    camel(`${name}-${key}`),
                    strict,
                    { required: schema.required?.includes(key) },
                  ),
              }))
              .reduce((acc, curr) => ({ ...acc, ...curr }), {}),
          ]);
          break;
        }

        if (schema.additionalProperties) {
          functions.push([
            'additionalProperties',
            generateValibotValidationSchemaDefinition(
              isBoolean(schema.additionalProperties)
                ? {}
                : (schema.additionalProperties as OpenApiSchemaObject),
              context,
              name,
              strict,
              { required: true },
            ),
          ]);
          break;
        }

        functions.push(['object', {}]);
        break;
      }

      case 'integer':
      case 'number': {
        functions.push(['number', undefined]);
        if (type === 'integer') {
          functions.push(['integer', undefined]);
        }
        break;
      }

      case 'string': {
        // When useDates is enabled, transform ISO date/date-time strings to Date.
        const wantsDate =
          context.output.override.useDates &&
          (schema.format === 'date' || schema.format === 'date-time');

        functions.push(['string', undefined]);

        if (schema.format === 'email') {
          functions.push(['email', undefined]);
        } else if (schema.format === 'uri' || schema.format === 'hostname') {
          functions.push(['url', undefined]);
        } else if (schema.format === 'uuid') {
          functions.push(['uuid', undefined]);
        } else if (schema.format === 'date') {
          functions.push(['isoDate', undefined]);
          if (wantsDate) functions.push(['toDate', undefined]);
        } else if (schema.format === 'time') {
          functions.push(['isoTime', undefined]);
        } else if (schema.format === 'date-time') {
          functions.push(['isoDateTime', undefined]);
          if (wantsDate) functions.push(['toDate', undefined]);
        }

        break;
      }

      case 'boolean': {
        functions.push(['boolean', undefined]);
        break;
      }

      case 'null': {
        functions.push(['null', undefined]);
        break;
      }

      case 'unknown': {
        functions.push(['unknown', undefined]);
        break;
      }

      default: {
        if (schema.enum) {
          break;
        }
        functions.push(['unknown', undefined]);
        break;
      }
    }
  }

  // const / enum / pattern / numeric constraints
  if ('const' in schema && schema.const !== undefined) {
    const constValue = isString(schema.const)
      ? `"${escape(schema.const)}"`
      : // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        stringify(schema.const);
    if (constValue !== undefined) {
      functions.splice(0, functions.length, ['literal', constValue]);
    }
  }

  if (schema.pattern) {
    consts.push(
      `export const ${name}RegExp${constsCounterValue} = new RegExp('${escape(
        schema.pattern,
      )}');`,
    );
    functions.push(['regex', `${name}RegExp${constsCounterValue}`]);
  }

  if (schema.enum) {
    if (schema.enum.every((value) => isString(value))) {
      functions.push([
        'picklist',
        `[${schema.enum.map((value) => `"${escape(value)}"`).join(', ')}]`,
      ]);
    } else {
      functions.push([
        'oneOf',
        schema.enum.map((value) => ({
          functions: [
            [
              'literal',
              isString(value) ? `"${escape(value)}"` : stringify(value),
            ],
          ],
          consts: [],
        })),
      ]);
    }
  }

  const isStringType = type === 'string';
  const isArrayType = type === 'array' || type === 'tuple';
  const isNumberType = type === 'number' || type === 'integer';

  if (isStringType || isArrayType) {
    if (min !== undefined) {
      functions.push(['minLength', `${min}`]);
    }
    if (max !== undefined) {
      functions.push(['maxLength', `${max}`]);
    }
  }

  if (isNumberType) {
    if (schema.multipleOf !== undefined) {
      functions.push(['multipleOf', `${schema.multipleOf}`]);
    }
    if (schema.minimum !== undefined) {
      functions.push(['minValue', `${schema.minimum}`]);
    }
    if (schema.maximum !== undefined) {
      functions.push(['maxValue', `${schema.maximum}`]);
    }
  }

  if (!required && schema.default !== undefined) {
    functions.push(['optional', defaultVarName]);
  } else if (!required && nullable) {
    functions.push(['nullish', undefined]);
  } else if (nullable) {
    functions.push(['nullable', undefined]);
  } else if (!required) {
    functions.push(['optional', undefined]);
  }

  if (schema.description) {
    functions.push(['description', `'${jsStringEscape(schema.description)}'`]);
  }

  return { functions, consts: unique(consts) };
};

export const parseValibotValidationSchemaDefinition = (
  input: ValibotValidationSchemaDefinition,
  _context: ContextSpec,
): { schema: string; consts: string } => {
  if (input.functions.length === 0) {
    return { schema: '', consts: '' };
  }

  let consts = '';
  consts += input.consts.join('\n');

    const parseDefinition = (def: ValibotValidationSchemaDefinition): string => {
    if (def.functions.length === 0) return '';
    if (def.consts.length > 0) {
      consts += (consts ? '\n' : '') + def.consts.join('\n');
    }

    let base: string | undefined;
    const actions: string[] = [];
    const wrappers: ((schema: string) => string)[] = [];

    const baseFrom = (fn: string, args: any): string => {
      if (fn === 'fileOrString') {
        return 'v.union([v.instance(File), v.string()])';
      }

      if (fn === 'allOf') {
        const parts = args as ValibotValidationSchemaDefinition[];
        if (parts.length === 1) return parseDefinition(parts[0]);
        const parsed = parts.map((p) => parseDefinition(p));
        return `v.intersect([${parsed.join(', ')}])`;
      }

      if (fn === 'oneOf' || fn === 'anyOf') {
        const parts = args as ValibotValidationSchemaDefinition[];
        if (parts.length === 1) return parseDefinition(parts[0]);
        const parsed = parts.map((p) => parseDefinition(p));
        return `v.union([${parsed.join(', ')}])`;
      }

      if (fn === 'additionalProperties') {
        const valueSchema = parseDefinition(args as ValibotValidationSchemaDefinition);
        return `v.record(v.string(), ${
          valueSchema || 'v.unknown()'
        })`;
      }

      if (fn === 'object' || fn === 'strictObject') {
        const props = args as Record<string, ValibotValidationSchemaDefinition>;
        return `v.${fn}({\n${Object.entries(props)
          .map(([key, schema]) => {
            const value = parseDefinition(schema);
            return `  ${JSON.stringify(key)}: ${value || 'v.unknown()'}`;
          })
          .join(',\n')}\n})`;
      }

      if (fn === 'array') {
        const valueSchema = parseDefinition(args as ValibotValidationSchemaDefinition);
        return `v.array(${valueSchema || 'v.unknown()'})`;
      }

      if (fn === 'tuple') {
        const items = (args as ValibotValidationSchemaDefinition[]).map((d) =>
          parseDefinition(d),
        );
        return `v.tuple([${items.map((x) => x || 'v.unknown()').join(', ')}])`;
      }

      if (fn === 'picklist') {
        return `v.picklist(${args})`;
      }

      if (fn === 'literal') {
        return `v.literal(${args})`;
      }

      if (fn === 'instance') {
        return `v.instance(${args})`;
      }

      if (fn === 'string' || fn === 'number' || fn === 'boolean' || fn === 'null' || fn === 'unknown') {
        return `v.${fn}()`;
      }

      return 'v.unknown()';
    };

    const actionFrom = (fn: string, args: any): string | undefined => {
      switch (fn) {
        case 'minLength':
          return `v.minLength(${args})`;
        case 'maxLength':
          return `v.maxLength(${args})`;
        case 'minValue':
          return `v.minValue(${args})`;
        case 'maxValue':
          return `v.maxValue(${args})`;
        case 'multipleOf':
          return `v.multipleOf(${args})`;
        case 'integer':
          return 'v.integer()';
        case 'regex':
          return `v.regex(${args})`;
        case 'email':
          return 'v.email()';
        case 'url':
          return 'v.url()';
        case 'uuid':
          return 'v.uuid()';
        case 'isoDate':
          return 'v.isoDate()';
        case 'isoTime':
          return 'v.isoTime()';
        case 'isoDateTime':
          return 'v.isoDateTime()';
        case 'toDate':
          return 'v.toDate()';
        default:
          return undefined;
      }
    };

    for (const [fn, args] of def.functions) {
      if (fn === 'optional') {
        wrappers.push((schema) =>
          args ? `v.optional(${schema}, ${args})` : `v.optional(${schema})`,
        );
        continue;
      }
      if (fn === 'nullable') {
        wrappers.push((schema) => `v.nullable(${schema})`);
        continue;
      }
      if (fn === 'nullish') {
        wrappers.push((schema) => `v.nullish(${schema})`);
        continue;
      }
      if (fn === 'description') {
        wrappers.push((schema) => `v.pipe(${schema}, v.description(${args}))`);
        continue;
      }

      const maybeAction = actionFrom(fn, args);
      if (maybeAction) {
        actions.push(maybeAction);
        continue;
      }

      base = baseFrom(fn, args);
    }

    if (!base) {
      base = 'v.unknown()';
    }

    let schema = base;
    if (actions.length > 0) {
      schema = `v.pipe(${schema}, ${actions.join(', ')})`;
    }

    for (const wrap of wrappers) {
      schema = wrap(schema);
    }

    return schema;
  };

  const schema = parseDefinition(input);
  // Some export consts includes `,` as prefix, adding replace to remove those
  if (consts.includes(',export')) {
    consts = consts.replaceAll(',export', '\nexport');
  }
  return { schema, consts };
};

const dereferenceScalar = (value: any, context: ContextSpec): unknown => {
  if (isObject(value)) {
    return dereference(value, context);
  } else if (Array.isArray(value)) {
    return value.map((item) => dereferenceScalar(item, context));
  } else {
    return value;
  }
};

export const dereference = (
  schema: OpenApiSchemaObject | OpenApiReferenceObject,
  context: ContextSpec,
): OpenApiSchemaObject => {
  const refName = '$ref' in schema ? schema.$ref : undefined;
  if (refName && context.parents?.includes(refName)) {
    return {};
  }

  const childContext: ContextSpec = {
    ...context,
    ...(refName
      ? { parents: [...(context.parents ?? []), refName] }
      : undefined),
  };

  const { schema: resolvedSchema } = resolveRef<OpenApiSchemaObject>(
    schema,
    childContext,
  );

  return Object.entries(resolvedSchema).reduce<any>((acc, [key, value]) => {
    if (key === 'properties' && isObject(value)) {
      acc[key] = Object.entries(value).reduce<
        Record<string, OpenApiSchemaObject>
      >((props, [propKey, propSchema]) => {
        props[propKey] = dereference(propSchema as any, childContext);
        return props;
      }, {});
    } else if (key === 'default' || key === 'example' || key === 'examples') {
      acc[key] = value;
    } else {
      acc[key] = dereferenceScalar(value, childContext);
    }

    return acc;
  }, {});
};

/**
 * Generate valibot schema for form-data request body.
 * Handles file type detection for top-level properties based on encoding.contentType
 * and contentMediaType. Mirrors type gen's resolveFormDataRootObject.
 */
const generateFormDataValibotSchema = (
  schema: OpenApiSchemaObject,
  context: ContextSpec,
  name: string,
  strict: boolean,
  encoding?: Record<string, { contentType?: string }>,
): ValibotValidationSchemaDefinition => {
  const propertyOverrides: Record<string, ValibotValidationSchemaDefinition> = {};

  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      const propSchema = schema.properties[key];
      const resolvedPropSchema = propSchema
        ? dereference(propSchema as any, context)
        : undefined;

      const fileType = resolvedPropSchema
        ? getFormDataFieldFileType(
            resolvedPropSchema,
            encoding?.[key]?.contentType,
          )
        : undefined;

      if (fileType) {
        const isRequired = schema.required?.includes(key);
        const fileFunctions: [string, unknown][] = [
          fileType === 'binary'
            ? ['instance', 'File']
            : ['fileOrString', undefined],
        ];
        if (!isRequired) {
          fileFunctions.push(['optional', undefined]);
        }
        propertyOverrides[key] = { functions: fileFunctions, consts: [] };
      }
    }
  }

  return generateValibotValidationSchemaDefinition(schema, context, name, strict, {
    required: true,
    propertyOverrides:
      Object.keys(propertyOverrides).length > 0 ? propertyOverrides : undefined,
  });
};

const parseBodyAndResponse = ({
  data,
  context,
  name,
  strict,
  generate,
  parseType,
}: {
  data:
    | OpenApiResponseObject
    | OpenApiRequestBodyObject
    | OpenApiReferenceObject
    | undefined;
  context: ContextSpec;
  name: string;
  strict: boolean;
  generate: boolean;
  parseType: 'body' | 'response';
}): {
  input: ValibotValidationSchemaDefinition;
  isArray: boolean;
  rules?: {
    min?: number;
    max?: number;
  };
} => {
  if (!data || !generate) {
    return { input: { functions: [], consts: [] }, isArray: false };
  }

  const resolvedRef = resolveRef<
    OpenApiResponseObject | OpenApiRequestBodyObject
  >(data, context).schema;

  const jsonMedia = resolvedRef.content?.['application/json'];
  const formDataMedia = resolvedRef.content?.['multipart/form-data'];
  const [contentType, mediaType] = jsonMedia
    ? (['application/json', jsonMedia] as const)
    : formDataMedia
      ? (['multipart/form-data', formDataMedia] as const)
      : [undefined, undefined];

  const schema = mediaType?.schema;
  if (!schema) {
    return { input: { functions: [], consts: [] }, isArray: false };
  }

  const encoding = mediaType.encoding;
  const resolvedJsonSchema = dereference(schema as any, context);

  if (resolvedJsonSchema.items) {
    const min =
      resolvedJsonSchema.minimum ??
      resolvedJsonSchema.minLength ??
      resolvedJsonSchema.minItems;
    const max =
      resolvedJsonSchema.maximum ??
      resolvedJsonSchema.maxLength ??
      resolvedJsonSchema.maxItems;

    return {
      input: generateValibotValidationSchemaDefinition(
        parseType === 'body'
          ? removeReadOnlyProperties(resolvedJsonSchema.items as OpenApiSchemaObject)
          : (resolvedJsonSchema.items as OpenApiSchemaObject),
        context,
        name,
        strict,
        { required: true },
      ),
      isArray: true,
      rules: {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      },
    };
  }

  const effectiveSchema =
    parseType === 'body' ? removeReadOnlyProperties(resolvedJsonSchema) : resolvedJsonSchema;

  const isFormData = contentType === 'multipart/form-data';

  return {
    input: isFormData
      ? generateFormDataValibotSchema(
          effectiveSchema,
          context,
          name,
          strict,
          encoding,
        )
      : generateValibotValidationSchemaDefinition(effectiveSchema, context, name, strict, {
          required: true,
        }),
    isArray: false,
  };
};

export const parseParameters = ({
  data,
  context,
  operationName,
  strict,
  generate,
}: {
  data: (OpenApiParameterObject | OpenApiReferenceObject)[] | undefined;
  context: ContextSpec;
  operationName: string;
  strict: {
    param: boolean;
    query: boolean;
    header: boolean;
    body: boolean;
    response: boolean;
  };
  generate: {
    param: boolean;
    query: boolean;
    header: boolean;
    body: boolean;
    response: boolean;
  };
}): {
  headers: ValibotValidationSchemaDefinition;
  queryParams: ValibotValidationSchemaDefinition;
  params: ValibotValidationSchemaDefinition;
} => {
  if (!data) {
    return {
      headers: { functions: [], consts: [] },
      queryParams: { functions: [], consts: [] },
      params: { functions: [], consts: [] },
    };
  }

  const definitionsByParameters = data.reduce<
    Record<
      'headers' | 'queryParams' | 'params',
      Record<string, ValibotValidationSchemaDefinition>
    >
  >(
    (acc, val) => {
      const { schema: parameter } = resolveRef<OpenApiParameterObject>(
        val,
        context,
      );

      if (!parameter.schema) return acc;

      const schema = dereference(parameter.schema as any, context);
      schema.description = parameter.description;

      const mapStrict = {
        path: strict.param,
        query: strict.query,
        header: strict.header,
      };

      const mapGenerate = {
        path: generate.param,
        query: generate.query,
        header: generate.header,
      };

      const definition = generateValibotValidationSchemaDefinition(
        schema,
        context,
        camel(`${operationName}-${parameter.in}-${parameter.name}`),
        getPropertySafe(mapStrict, parameter.in).value ?? false,
        { required: parameter.required },
      );

      if (parameter.in === 'header' && mapGenerate.header) {
        return { ...acc, headers: { ...acc.headers, [parameter.name]: definition } };
      }

      if (parameter.in === 'query' && mapGenerate.query) {
        return {
          ...acc,
          queryParams: { ...acc.queryParams, [parameter.name]: definition },
        };
      }

      if (parameter.in === 'path' && mapGenerate.path) {
        return { ...acc, params: { ...acc.params, [parameter.name]: definition } };
      }

      return acc;
    },
    { headers: {}, queryParams: {}, params: {} },
  );

  const headers: ValibotValidationSchemaDefinition = { functions: [], consts: [] };
  if (Object.keys(definitionsByParameters.headers).length > 0) {
    headers.functions.push(
      ...getParameterFunctions(strict.header, definitionsByParameters.headers),
    );
  }

  const queryParams: ValibotValidationSchemaDefinition = { functions: [], consts: [] };
  if (Object.keys(definitionsByParameters.queryParams).length > 0) {
    queryParams.functions.push(
      ...getParameterFunctions(strict.query, definitionsByParameters.queryParams),
    );
  }

  const params: ValibotValidationSchemaDefinition = { functions: [], consts: [] };
  if (Object.keys(definitionsByParameters.params).length > 0) {
    params.functions.push(
      ...getParameterFunctions(strict.param, definitionsByParameters.params),
    );
  }

  return { headers, queryParams, params };
};

const generateValibotRoute = async (
  { operationName, verb, override }: GeneratorVerbOptions,
  { pathRoute, context }: GeneratorOptions,
) => {
  const spec = context.spec.paths?.[pathRoute];
  if (spec == undefined) {
    throw new Error(`No such path ${pathRoute} in ${context.projectName}`);
  }

  const parameters = [
    ...(spec.parameters ?? []),
    ...(spec[verb]?.parameters ?? []),
  ];

  const parsedParameters = parseParameters({
    data: parameters,
    context,
    operationName,
    strict: override.valibot.strict,
    generate: override.valibot.generate,
  });

  const requestBody = spec[verb]?.requestBody;
  const parsedBody = parseBodyAndResponse({
    data: requestBody,
    context,
    name: camel(`${operationName}-body`),
    strict: override.valibot.strict.body,
    generate: override.valibot.generate.body,
    parseType: 'body',
  });

  const responsesObj = spec[verb]?.responses ?? {};
  const responseToUse =
    (responsesObj as any)['200'] ?? Object.values(responsesObj)[0];

  const parsedResponses = responseToUse
    ? [
        parseBodyAndResponse({
          data: responseToUse as any,
          context,
          name: camel(`${operationName}-response`),
          strict: override.valibot.strict.response,
          generate: override.valibot.generate.response,
          parseType: 'response',
        }),
      ]
    : [];

  const inputParams = parseValibotValidationSchemaDefinition(
    parsedParameters.params,
    context,
  );
  const inputQueryParams = parseValibotValidationSchemaDefinition(
    parsedParameters.queryParams,
    context,
  );
  const inputHeaders = parseValibotValidationSchemaDefinition(
    parsedParameters.headers,
    context,
  );
  const inputBody = parseValibotValidationSchemaDefinition(parsedBody.input, context);
  const inputResponses = parsedResponses.map((parsedResponse) =>
    parseValibotValidationSchemaDefinition(parsedResponse.input, context),
  );

  if (
    !inputParams.schema &&
    !inputQueryParams.schema &&
    !inputHeaders.schema &&
    !inputBody.schema &&
    !inputResponses.some((r) => r.schema)
  ) {
    return { implementation: '', mutators: [] };
  }

  const pascalOperationName = pascal(operationName);

  const arrayRulesToPipeActions = (rules?: { min?: number; max?: number }) => {
    const out: string[] = [];
    if (rules?.min !== undefined) out.push(`v.minLength(${rules.min})`);
    if (rules?.max !== undefined) out.push(`v.maxLength(${rules.max})`);
    return out;
  };

  return {
    implementation: [
      ...(inputParams.consts ? [inputParams.consts] : []),
      ...(inputParams.schema
        ? [`export const ${pascalOperationName}Params = ${inputParams.schema}`]
        : []),
      ...(inputQueryParams.consts ? [inputQueryParams.consts] : []),
      ...(inputQueryParams.schema
        ? [
            `export const ${pascalOperationName}QueryParams = ${inputQueryParams.schema}`,
          ]
        : []),
      ...(inputHeaders.consts ? [inputHeaders.consts] : []),
      ...(inputHeaders.schema
        ? [`export const ${pascalOperationName}Header = ${inputHeaders.schema}`]
        : []),
      ...(inputBody.consts ? [inputBody.consts] : []),
      ...(inputBody.schema
        ? [
            parsedBody.isArray
              ? `export const ${pascalOperationName}BodyItem = ${inputBody.schema}
export const ${pascalOperationName}Body = v.pipe(v.array(${pascalOperationName}BodyItem)${
                  arrayRulesToPipeActions(parsedBody.rules).length > 0
                    ? `, ${arrayRulesToPipeActions(parsedBody.rules).join(', ')}`
                    : ''
                })`
              : `export const ${pascalOperationName}Body = ${inputBody.schema}`,
          ]
        : []),
      ...inputResponses.flatMap((inputResponse, index) => {
        const operationResponse = pascal(`${operationName}-response`);
        const parsedResponse = parsedResponses[index];
        return [
          ...(inputResponse.consts ? [inputResponse.consts] : []),
          ...(inputResponse.schema
            ? [
                parsedResponse.isArray
                  ? `export const ${operationResponse}Item = ${inputResponse.schema}
export const ${operationResponse} = v.pipe(v.array(${operationResponse}Item)${
                      arrayRulesToPipeActions(parsedResponse.rules).length > 0
                        ? `, ${arrayRulesToPipeActions(parsedResponse.rules).join(', ')}`
                        : ''
                    })`
                  : `export const ${operationResponse} = ${inputResponse.schema}`,
              ]
            : []),
        ];
      }),
    ].join('\n\n'),
    mutators: [],
  };
};

export const generateValibot: ClientBuilder = async (verbOptions, options) => {
  const { implementation, mutators } = await generateValibotRoute(
    verbOptions,
    options,
  );

  return {
    implementation: implementation ? `${implementation}\n\n` : '',
    imports: [],
    mutators,
  };
};

const valibotClientBuilder: ClientGeneratorsBuilder = {
  client: generateValibot,
  dependencies: getValibotDependencies,
};

export const builder = () => () => valibotClientBuilder;

export default builder;
