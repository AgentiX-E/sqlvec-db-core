export class ConnectionPool { 
  constructor(_config: any) {}
  getPoolStats() { return []; }
  getStats() { return { active: 0, idle: 0, waiting: 0 }; }
}
