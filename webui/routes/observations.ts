import {
  getObservations,
  getObservationById,
  getExportableObservations,
  upsertLabel,
  type ObservationListRow,
  type ObservationDetailRow,
} from '../db.js';

export function handleGetObservations(
  query: Record<string, string>,
): ObservationListRow[] {
  const sourceType = query.sourceType || undefined;
  const labelled =
    query.labelled === 'true'
      ? true
      : query.labelled === 'false'
        ? false
        : undefined;
  const limit = query.limit ? parseInt(query.limit, 10) : undefined;
  const offset = query.offset ? parseInt(query.offset, 10) : undefined;

  return getObservations({ sourceType, labelled, limit, offset });
}

export function handleGetObservation(
  id: number,
): ObservationDetailRow | null {
  return getObservationById(id) ?? null;
}

export function handlePatchLabel(
  observationId: number,
  body: {
    intent?: string;
    form?: string;
    imperativeContent?: string;
    addressee?: string;
    embeddedInstructions?: string;
    adversarialSmell?: boolean;
    notes?: string;
    expectedJson?: string;
  },
): { success: true } | { error: string } {
  const obs = getObservationById(observationId);
  if (!obs) return { error: 'Observation not found' };

  upsertLabel(observationId, {
    intent: body.intent,
    form: body.form,
    imperative_content: body.imperativeContent,
    addressee: body.addressee,
    embedded_instructions: body.embeddedInstructions,
    adversarial_smell: body.adversarialSmell,
    notes: body.notes,
    expected_json: body.expectedJson,
  });

  return { success: true };
}

export function handleExportEvalSet(): unknown[] {
  const rows = getExportableObservations();
  return rows.map((row) => {
    let expectedLayer1: Record<string, unknown> = {};
    let expectedLayer2: Record<string, unknown> = {};
    try {
      expectedLayer1 = JSON.parse(row.sanitised_json);
    } catch {}
    try {
      expectedLayer2 = JSON.parse(row.expected_json);
    } catch {}
    return {
      id: String(row.id),
      description: row.raw_text.length > 80 ? row.raw_text.slice(0, 80) + '...' : row.raw_text,
      tags: [row.source_type],
      input: { raw_text: row.raw_text },
      expected_layer1: expectedLayer1,
      expected_layer2: expectedLayer2,
    };
  });
}
