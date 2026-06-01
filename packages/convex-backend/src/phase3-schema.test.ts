import { describe, expect, it } from 'vitest';
import schema from '../convex/schema.js';

describe('Phase 3 Convex schema foundation', () => {
  it('defines learning-loop tables, indexes, unions, and Finding extensions', () => {
    const archetypes = table('archetypes');
    const reactions = table('reactions');
    const suggestedRules = table('suggestedRules');
    const findings = table('findings');

    expect(archetypes.indexes).toContainEqual({
      indexDescriptor: 'by_product',
      fields: ['productId'],
    });
    expect(archetypes.vectorIndexes).toEqual([
      {
        indexDescriptor: 'by_exemplar_embedding_and_product',
        vectorField: 'exemplarEmbedding',
        dimensions: 1536,
        filterFields: ['productId'],
      },
    ]);
    expectField(archetypes, 'productId', idType('products'));
    expectField(archetypes, 'label', { type: 'string' });
    expectField(archetypes, 'exemplarEmbedding', arrayType({ type: 'number' }));
    expectField(archetypes, 'exampleFindingIds', arrayType(idType('findings')));
    expectField(archetypes, 'count', { type: 'number' });
    expectField(archetypes, 'suppressionWeight', { type: 'number' });

    expect(reactions.indexes).toContainEqual({
      indexDescriptor: 'by_finding',
      fields: ['findingId'],
    });
    expectField(reactions, 'findingId', idType('findings'));
    expectLiteralUnion(reactions, 'kind', ['👍', '👎', 'mergedFixed', 'mergedIgnored']);
    expectField(reactions, 'replyText', { type: 'string' }, { optional: true });

    expect(suggestedRules.indexes).toEqual(
      expect.arrayContaining([
        { indexDescriptor: 'by_status', fields: ['status'] },
        { indexDescriptor: 'by_source_archetype', fields: ['sourceArchetypeId'] },
      ]),
    );
    expectField(suggestedRules, 'productId', idType('products'));
    expectLiteralUnion(suggestedRules, 'type', ['positive', 'suppression']);
    expectLiteralUnion(suggestedRules, 'status', [
      'suggested',
      'promoteToPositive',
      'promoteToSuppression',
      'rejected',
      'promoted',
    ]);
    expectField(suggestedRules, 'description', { type: 'string' });
    expectField(suggestedRules, 'sourceArchetypeId', idType('archetypes'));
    expectField(suggestedRules, 'evidence', { type: 'string' });

    expectField(findings, 'embedding', arrayType({ type: 'number' }), { optional: true });
    expectField(findings, 'archetypeId', idType('archetypes'), { optional: true });

    for (const tableName of ['archetypes', 'reactions', 'suggestedRules']) {
      expect(table(tableName).documentType.value).not.toHaveProperty('createdAt');
    }
  });
});

interface SchemaExport {
  tables: TableExport[];
}

interface TableExport {
  tableName: string;
  indexes: Array<{ indexDescriptor: string; fields: string[] }>;
  vectorIndexes: Array<{
    indexDescriptor: string;
    vectorField: string;
    dimensions: number;
    filterFields: string[];
  }>;
  documentType: { value: Record<string, FieldExport> };
}

interface FieldExport {
  fieldType: FieldType;
  optional: boolean;
}

interface FieldType {
  type: string;
  tableName?: string;
  value?: unknown;
}

const exportedSchema = JSON.parse(schema.export()) as SchemaExport;

function table(name: string): TableExport {
  const found = exportedSchema.tables.find((candidate) => candidate.tableName === name);
  if (found === undefined) {
    throw new Error(`Missing table ${name}`);
  }
  return found;
}

function expectField(
  tableExport: TableExport,
  fieldName: string,
  fieldType: FieldType,
  options: { optional?: boolean } = {},
) {
  expect(tableExport.documentType.value[fieldName]).toEqual({
    fieldType,
    optional: options.optional ?? false,
  });
}

function expectLiteralUnion(tableExport: TableExport, fieldName: string, values: unknown[]) {
  const field = tableExport.documentType.value[fieldName];
  expect(field?.optional).toBe(false);
  expect(field?.fieldType).toEqual({
    type: 'union',
    value: values.map((value) => ({ type: 'literal', value })),
  });
}

function idType(tableName: string): FieldType {
  return { type: 'id', tableName };
}

function arrayType(value: FieldType): FieldType {
  return { type: 'array', value };
}
