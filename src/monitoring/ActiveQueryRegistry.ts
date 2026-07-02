import type { ActiveQuery } from './ConnectionManager';
export class ActiveQueryRegistry {
  getActiveQueries(): ActiveQuery[] { return []; }
  list(): ActiveQuery[] { return []; }
}
