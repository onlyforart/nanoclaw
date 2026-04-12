import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

export interface FieldEntry {
  name: string;
  description: string;
  prompt_fragment: string;
  output_type: string;
  max_length: number;
}

export interface FieldCatalog {
  version: number;
  fields: FieldEntry[];
}

let catalog: FieldCatalog | null = null;

export function loadFieldCatalog(
  catalogPath?: string,
): FieldCatalog {
  const filePath =
    catalogPath ??
    path.join(process.cwd(), 'pipeline', 'field-catalog.yaml');
  const raw = fs.readFileSync(filePath, 'utf-8');
  catalog = parseYaml(raw) as FieldCatalog;
  return catalog;
}

export function getFieldEntry(name: string): FieldEntry | undefined {
  if (!catalog) return undefined;
  return catalog.fields.find((f) => f.name === name);
}

export function listFieldNames(): string[] {
  if (!catalog) return [];
  return catalog.fields.map((f) => f.name);
}
