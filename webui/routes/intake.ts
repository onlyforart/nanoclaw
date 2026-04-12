import { getIntakeLogs, type IntakeLogRow } from '../db.js';

export function handleGetIntakeLogs(query: Record<string, string>): IntakeLogRow[] {
  const includeProcessed = query.includeProcessed !== 'false';
  const limit = query.limit ? parseInt(query.limit, 10) : undefined;

  return getIntakeLogs({ includeProcessed, limit });
}
