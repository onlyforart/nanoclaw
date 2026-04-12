import { getEvents, type EventRow } from '../db.js';

export function handleGetEvents(query: Record<string, string>): EventRow[] {
  const types = query.types ? query.types.split(',') : undefined;
  const status = query.status || undefined;
  const limit = query.limit ? parseInt(query.limit, 10) : undefined;

  return getEvents({ types, status, limit });
}
