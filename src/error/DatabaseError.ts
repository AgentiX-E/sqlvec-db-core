export class DatabaseError extends Error { constructor(msg: string, _code?: string) { super(msg); } }
export const SqlVecError = DatabaseError;
