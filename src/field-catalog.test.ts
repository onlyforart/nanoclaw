import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  loadFieldCatalog,
  getFieldEntry,
  listFieldNames,
} from './field-catalog.js';

const CATALOG_PATH = path.join(process.cwd(), 'pipeline', 'field-catalog.yaml');
const catalogExists = fs.existsSync(CATALOG_PATH);

// field-catalog.yaml is gitignored (lives in a private repo).
// These tests skip when the file is not present.

describe.skipIf(!catalogExists)('loadFieldCatalog', () => {
  it('loads the catalog from the default path', () => {
    const catalog = loadFieldCatalog(CATALOG_PATH);
    expect(catalog.version).toBe(1);
    expect(catalog.fields.length).toBeGreaterThan(0);
  });

  it('each field has name, description, prompt_fragment, output_type, max_length', () => {
    const catalog = loadFieldCatalog(CATALOG_PATH);
    for (const field of catalog.fields) {
      expect(field.name).toBeTruthy();
      expect(field.description).toBeTruthy();
      expect(field.prompt_fragment).toBeTruthy();
      expect(field.output_type).toBeTruthy();
      expect(field.max_length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!catalogExists)('getFieldEntry', () => {
  it('returns a field by name', () => {
    loadFieldCatalog(CATALOG_PATH);
    const entry = getFieldEntry('code_snippets');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('code_snippets');
    expect(entry!.prompt_fragment).toBeTruthy();
  });

  it('returns undefined for unknown field name', () => {
    loadFieldCatalog(CATALOG_PATH);
    expect(getFieldEntry('nonexistent_field')).toBeUndefined();
  });
});

describe.skipIf(!catalogExists)('listFieldNames', () => {
  it('returns all available field names', () => {
    loadFieldCatalog(CATALOG_PATH);
    const names = listFieldNames();
    expect(names).toContain('code_snippets');
    expect(names).toContain('error_messages');
    expect(names).toContain('affected_systems');
    expect(names.length).toBeGreaterThanOrEqual(5);
  });
});
