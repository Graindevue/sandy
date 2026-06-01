import type { JSONValue, ValidatorJSON } from 'convex/values';
import { describe, expect, it } from 'vitest';
import {
  REACTION_KINDS,
  SUGGESTED_RULE_STATUSES,
  SUGGESTED_RULE_TYPES,
} from '../../shared-types/src/learning.js';
import schema, { TEXT_EMBEDDING_3_SMALL_DIMENSIONS } from '../convex/schema.js';
import {
  arrayType,
  expectFields,
  expectIndexes,
  exportSchema,
  type FieldExport,
  getTable,
  idType,
  optional,
  required,
  type VectorIndexExport,
} from './schemaExportTestUtils.js';

const exportedSchema = exportSchema(schema);

describe('Phase 3 Convex schema foundation', () => {
  it('defines learning-loop tables with their query indexes', () => {
    expectIndexes(table('archetypes'), [{ indexDescriptor: 'by_product', fields: ['productId'] }]);
    expect(table('archetypes').vectorIndexes).toEqual([archetypeVectorIndex]);
    expectIndexes(table('reactions'), [{ indexDescriptor: 'by_finding', fields: ['findingId'] }]);
    expectIndexes(table('suggestedRules'), [
      { indexDescriptor: 'by_status', fields: ['status'] },
      { indexDescriptor: 'by_source_archetype', fields: ['sourceArchetypeId'] },
    ]);
    expectIndexes(table('findings'), [
      { indexDescriptor: 'by_archetype', fields: ['archetypeId'] },
    ]);
    expectIndexes(table('pullRequests'), [
      {
        indexDescriptor: 'by_state_and_merge_state_signals_rolled_up_at',
        fields: ['state', 'mergeStateSignalsRolledUpAt'],
      },
    ]);
  });

  it('defines learning-loop table fields and Finding extensions', () => {
    for (const tableName of learningLoopTables) {
      expectFields(table(tableName), expectedLearningTableFields[tableName]);
    }

    for (const [fieldName, field] of Object.entries(expectedFindingExtensions)) {
      expect(table('findings').documentType.value[fieldName]).toEqual(field);
    }
    for (const tableName of learningLoopTables) {
      expect(table(tableName).documentType.value).not.toHaveProperty('createdAt');
    }
    expect(table('pullRequests').documentType.value.mergeStateSignalsRolledUpAt).toEqual(
      optional({ type: 'number' }),
    );
  });
});

const learningLoopTables = ['archetypes', 'reactions', 'suggestedRules'] as const;
type LearningLoopTableName = (typeof learningLoopTables)[number];

const archetypeVectorIndex = {
  indexDescriptor: 'by_exemplar_embedding_and_product',
  vectorField: 'exemplarEmbedding',
  dimensions: TEXT_EMBEDDING_3_SMALL_DIMENSIONS,
  filterFields: ['productId'],
} satisfies VectorIndexExport;

const expectedLearningTableFields = {
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
} satisfies Record<LearningLoopTableName, Record<string, FieldExport>>;

const expectedFindingExtensions = {
  embedding: optional(arrayType({ type: 'number' })),
  archetypeId: optional(idType('archetypes')),
} satisfies Record<string, FieldExport>;

function literalUnion(values: readonly JSONValue[]): ValidatorJSON {
  return {
    type: 'union',
    value: values.map((value) => ({ type: 'literal', value })),
  };
}

function table(name: string) {
  return getTable(exportedSchema, name);
}
