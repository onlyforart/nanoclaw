import {
  getObservations,
  getObservationById,
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
