import type { JSONValue, ValidatorJSON } from 'convex/values';
import { describe, expect, it } from 'vitest';
import {
  REACTION_KINDS,
  SUGGESTED_RULE_STATUSES,
  SUGGESTED_RULE_TYPES,
} from '../../shared-types/src/learning.js';
import schema, { TEXT_EMBEDDING_3_SMALL_DIMENSIONS } from '../convex/schema.js';

describe('Phase 3 Convex schema foundation', () => {
  it('defines learning-loop tables with their query indexes', () => {
    expectIndexes('archetypes', [{ indexDescriptor: 'by_product', fields: ['productId'] }]);
    expect(table('archetypes').vectorIndexes).toEqual([
      {
        indexDescriptor: 'by_exemplar_embedding_and_product',
        vectorField: 'exemplarEmbedding',
        dimensions: TEXT_EMBEDDING_3_SMALL_DIMENSIONS,
        filterFields: ['productId'],
      },
    ]);
    expectIndexes('reactions', [{ indexDescriptor: 'by_finding', fields: ['findingId'] }]);
    expectIndexes('suggestedRules', [
      { indexDescriptor: 'by_status', fields: ['status'] },
      { indexDescriptor: 'by_source_archetype', fields: ['sourceArchetypeId'] },
    ]);
    expectIndexes('findings', [{ indexDescriptor: 'by_archetype', fields: ['archetypeId'] }]);
  });

  it('defines learning-loop table fields and Finding extensions', () => {
    for (const [tableName, fields] of Object.entries(expectedFields)) {
      for (const [fieldName, field] of Object.entries(fields)) {
        expectField(table(tableName), fieldName, field);
      }
    }

    for (const tableName of learningLoopTables) {
      expect(table(tableName).documentType.value).not.toHaveProperty('createdAt');
    }
  });
});

interface SchemaExport {
  tables: TableExport[];
}

interface TableExport {
  tableName: string;
  indexes: IndexExport[];
  vectorIndexes: Array<{
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }>;
  documentType: { value: Record<string, FieldExport> };
}

interface IndexExport {
  indexDescriptor: string;
  fields: string[];
}

interface FieldExport {
  fieldType: ValidatorJSON;
  optional: boolean;
}

interface ExportableSchema {
  export(): string;
}

// Convex codegen uses this exporter, but the public .d.ts intentionally hides it.
const exportedSchema = JSON.parse((schema as unknown as ExportableSchema).export()) as SchemaExport;

const learningLoopTables = ['archetypes', 'reactions', 'suggestedRules'] as const;

const required = (fieldType: ValidatorJSON): FieldExport => ({ fieldType, optional: false });
const optional = (fieldType: ValidatorJSON): FieldExport => ({ fieldType, optional: true });

const expectedFields = {
  archetypes: {
    productId: required(idType('products')),
    label: required({ type: 'string' }),
    exemplarEmbedding: required(arrayType({ type: 'number' })),
    exampleFindingIds: required(arrayType(idType('findings'))),
    count: required({ type: 'number' }),
    suppressionWeight: required({ type: 'number' }),
  },
  reactions: {
    findingId: required(idType('findings')),
    kind: required(literalUnion(REACTION_KINDS)),
    replyText: optional({ type: 'string' }),
  },
  suggestedRules: {
    productId: required(idType('products')),
    type: required(literalUnion(SUGGESTED_RULE_TYPES)),
    status: required(literalUnion(SUGGESTED_RULE_STATUSES)),
    description: required({ type: 'string' }),
    sourceArchetypeId: required(idType('archetypes')),
    evidence: required({ type: 'string' }),
  },
  findings: {
    embedding: optional(arrayType({ type: 'number' })),
    archetypeId: optional(idType('archetypes')),
  },
} satisfies Record<string, Record<string, FieldExport>>;

function table(name: string): TableExport {
  const found = exportedSchema.tables.find((candidate) => candidate.tableName === name);
  if (found === undefined) {
    throw new Error(`Missing table ${name}`);
  }
  return found;
}

function expectIndexes(tableName: string, indexes: IndexExport[]) {
  expect(table(tableName).indexes).toEqual(expect.arrayContaining(indexes));
}

function expectField(tableExport: TableExport, fieldName: string, field: FieldExport) {
  expect(tableExport.documentType.value[fieldName]).toEqual(field);
}

function idType(tableName: string): ValidatorJSON {
  return { type: 'id', tableName };
}

function arrayType(value: ValidatorJSON): ValidatorJSON {
  return { type: 'array', value };
}

function literalUnion(values: readonly JSONValue[]): ValidatorJSON {
  return {
    type: 'union',
    value: values.map((value) => ({ type: 'literal', value })),
  };
}
