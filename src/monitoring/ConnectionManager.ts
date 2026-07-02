export interface ActiveQuery {
  pid: number; userId: string; clientAddr: string;
  queryStart: string; state: string; sql: string;
  database: string; userName: string; backendStart: string;
}
export class ConnectionManager {
  getActiveQueries(): ActiveQuery[] { return []; }
  getSessionIds(): string[] { return []; }
}
