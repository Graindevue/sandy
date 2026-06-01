import type { ValidatorJSON } from 'convex/values';
import { expect } from 'vitest';

interface ExportableSchema {
  export(): string;
}

export interface SchemaExport {
  tables: TableExport[];
}

export interface TableExport {
  tableName: string;
  indexes: IndexExport[];
  vectorIndexes: VectorIndexExport[];
  documentType: { value: Record<string, FieldExport> };
}

export interface IndexExport {
  indexDescriptor: string;
  fields: string[];
}

export interface VectorIndexExport {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  filterFields: string[];
}

export interface FieldExport {
  fieldType: ValidatorJSON;
  optional: boolean;
}

export function exportSchema(schema: unknown): SchemaExport {
  // Convex codegen uses this exporter, but the public .d.ts intentionally hides it.
  return JSON.parse((schema as ExportableSchema).export()) as SchemaExport;
}

export function getTable(schema: SchemaExport, name: string): TableExport {
  const found = schema.tables.find((candidate) => candidate.tableName === name);
  if (found === undefined) {
    throw new Error(`Missing table ${name}`);
  }
  return found;
}

export function expectIndexes(table: TableExport, indexes: IndexExport[]) {
  expect(table.indexes).toEqual(expect.arrayContaining(indexes));
}

export function expectFields(table: TableExport, fields: Record<string, FieldExport>) {
  expect(table.documentType.value).toEqual(fields);
}

export function required(fieldType: ValidatorJSON): FieldExport {
  return { fieldType, optional: false };
}

export function optional(fieldType: ValidatorJSON): FieldExport {
  return { fieldType, optional: true };
}

export function idType(tableName: string): ValidatorJSON {
  return { type: 'id', tableName };
}

export function arrayType(value: ValidatorJSON): ValidatorJSON {
  return { type: 'array', value };
}
