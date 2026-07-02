export class SQLInjectionGuard {
  static check(_sql: string) { return { blocked: false }; }
  static getInstance() { return new SQLInjectionGuard(); }
}
