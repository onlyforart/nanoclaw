/**
 * Sanitiser Layer 3 — deterministic post-processing.
 * Schema validation, field cap enforcement, quarantine.
 */

import type { Layer1Output } from './layer1.js';
import { parseAndValidateResponse, type Layer2Output } from './layer2.js';

export interface SanitiserFieldDef {
  type: 'string' | 'boolean' | 'enum';
  required: boolean;
  nullable?: boolean;
  max_length?: number;
  values?: string[];
  open?: boolean;
}

export interface SanitiserSchema {
  version: number;
  fields: Record<string, SanitiserFieldDef>;
}

export interface Layer3Input {
  layer1: Layer1Output;
  layer2Raw: string;
}

export interface Layer3Output {
  sanitised_json: Record<string, unknown> | null;
  flags: string[];
  quarantined: boolean;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a parsed object against the sanitiser schema.
 */
export function validateSchema(
  parsed: Record<string, unknown>,
  schema: SanitiserSchema,
): ValidationResult {
  for (const [field, def] of Object.entries(schema.fields)) {
    const value = parsed[field];

    // Check required fields
    if (def.required && value === undefined && !def.nullable) {
      return { valid: false, reason: `Missing required field: ${field}` };
    }

    // Skip validation for absent optional/nullable fields
    if (value === undefined || value === null) {
      if (def.required && !def.nullable && value === null) {
        return { valid: false, reason: `Required field ${field} is null` };
      }
      continue;
    }

    // Type checks
    switch (def.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          return {
            valid: false,
            reason: `Field ${field} must be boolean, got ${typeof value}`,
          };
        }
        break;
      case 'string':
        if (typeof value !== 'string') {
          return {
            valid: false,
            reason: `Field ${field} must be string, got ${typeof value}`,
          };
        }
        break;
      case 'enum':
        if (typeof value !== 'string') {
          return {
            valid: false,
            reason: `Field ${field} must be string (enum), got ${typeof value}`,
          };
        }
        break;
    }
  }

  return { valid: true };
}

/**
 * Hard-truncate string fields to their caps.
 */
export function enforceFieldCaps(
  obj: Record<string, unknown>,
  caps: Record<string, number>,
): Record<string, unknown> {
  const result = { ...obj };
  for (const [field, maxLen] of Object.entries(caps)) {
    const value = result[field];
    if (typeof value === 'string' && value.length > maxLen) {
      result[field] = value.slice(0, maxLen);
    }
  }
  return result;
}

/**
 * Validate enum fields against known values. Open enums allow unknown values
 * but report them for review.
 */
export function validateEnums(
  obj: Record<string, unknown>,
  enums: Record<string, string[]>,
): { valid: boolean; unknownValues: Array<{ field: string; value: string }> } {
  const unknownValues: Array<{ field: string; value: string }> = [];

  for (const [field, knownValues] of Object.entries(enums)) {
    const value = obj[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return { valid: false, unknownValues };
    }
    if (!knownValues.includes(value)) {
      unknownValues.push({ field, value });
    }
  }

  return { valid: true, unknownValues };
}

/**
 * Produce a quarantined output.
 */
export function quarantine(reason: string): Layer3Output {
  return {
    sanitised_json: null,
    flags: ['schema_invalid', reason],
    quarantined: true,
  };
}

/**
 * Post-process Layer 2 output: validate, cap, combine with Layer 1.
 */
export function postProcess(
  input: Layer3Input,
  schema: SanitiserSchema,
): Layer3Output {
  // Parse Layer 2 raw response
  const parsed = parseAndValidateResponse(input.layer2Raw);
  if (!parsed) {
    return quarantine('Layer 2 output failed JSON parsing or validation');
  }

  // Validate against schema
  const schemaResult = validateSchema(
    parsed as unknown as Record<string, unknown>,
    schema,
  );
  if (!schemaResult.valid) {
    return quarantine(schemaResult.reason || 'Schema validation failed');
  }

  // Enforce field caps
  const caps: Record<string, number> = {};
  for (const [field, def] of Object.entries(schema.fields)) {
    if (def.max_length) caps[field] = def.max_length;
  }
  const capped = enforceFieldCaps(
    parsed as unknown as Record<string, unknown>,
    caps,
  );

  // Validate enums (open — unknown values allowed but flagged)
  const enumDefs: Record<string, string[]> = {};
  for (const [field, def] of Object.entries(schema.fields)) {
    if (def.type === 'enum' && def.values) {
      enumDefs[field] = def.values;
    }
  }
  const enumResult = validateEnums(capped, enumDefs);
  if (!enumResult.valid) {
    return quarantine('Non-string value in enum field');
  }

  const flags: string[] = [];
  if (enumResult.unknownValues.length > 0) {
    flags.push('unknown_enum_value');
  }

  // Combine Layer 1 + Layer 2 into sanitised output
  const sanitised_json: Record<string, unknown> = {
    // Layer 1 deterministic fields
    sender_id: input.layer1.sender_id,
    channel_id: input.layer1.channel_id,
    thread_ts: input.layer1.thread_ts,
    timestamp: input.layer1.timestamp,
    referenced_tickets: input.layer1.referenced_tickets,
    inc_present: input.layer1.inc_present,
    code_blocks: input.layer1.code_blocks,
    links: input.layer1.links,
    mentions: input.layer1.mentions,
    is_bot_message: input.layer1.is_bot_message,
    message_length: input.layer1.message_length,
    // Layer 2 LLM-extracted fields (capped)
    ...capped,
  };

  return {
    sanitised_json,
    flags,
    quarantined: false,
  };
}
