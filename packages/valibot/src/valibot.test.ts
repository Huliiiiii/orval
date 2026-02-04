import type { ContextSpec, OpenApiSchemaObject } from '@orval/core';
import { describe, expect, it } from 'vitest';

import {
  generateValibotValidationSchemaDefinition,
  parseValibotValidationSchemaDefinition,
  type ValibotValidationSchemaDefinition,
} from '.';

describe('parseValibotValidationSchemaDefinition', () => {
  it('treats additionalProperties properly', () => {
    const record: ValibotValidationSchemaDefinition = {
      functions: [
        [
          'object',
          {
            queryParams: {
              functions: [
                [
                  'additionalProperties',
                  {
                    functions: [['unknown', undefined]],
                    consts: [],
                  },
                ],
              ],
              consts: [],
            },
          },
        ],
      ],
      consts: [],
    };

    const parseResult = parseValibotValidationSchemaDefinition(
      record,
      {
        output: {
          override: {
            useDates: false,
          },
        },
      } as ContextSpec,
    );

    expect(parseResult.schema).toBe(
      'v.object({\n  "queryParams": v.record(v.string(), v.unknown())\n})',
    );
  });
});

describe('generateValibotValidationSchemaDefinition', () => {
  it('generates optional properties and constraints', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', minLength: 1 },
      },
    };

    const def = generateValibotValidationSchemaDefinition(
      schema,
      {
        output: { override: { useDates: false } },
      } as ContextSpec,
      'User',
      false,
      { required: true },
    );

    const parsed = parseValibotValidationSchemaDefinition(
      def,
      { output: { override: { useDates: false } } } as ContextSpec,
    );

    expect(parsed.schema).toBe(
      'v.object({\n  "id": v.pipe(v.number(), v.integer()),\n  "name": v.optional(v.pipe(v.string(), v.minLength(1)))\n})',
    );
  });

  it('adds description metadata', () => {
    const schema: OpenApiSchemaObject = {
      type: 'string',
      description: 'hello',
    };

    const def = generateValibotValidationSchemaDefinition(
      schema,
      { output: { override: { useDates: false } } } as ContextSpec,
      'Greeting',
      false,
      { required: true },
    );

    const parsed = parseValibotValidationSchemaDefinition(
      def,
      { output: { override: { useDates: false } } } as ContextSpec,
    );

    expect(parsed.schema).toBe(
      "v.pipe(v.string(), v.description('hello'))",
    );
  });
});
