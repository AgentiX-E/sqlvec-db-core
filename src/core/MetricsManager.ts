export class MetricsManager { sqlvecQueriesTotal?: { inc: (v?: number) => void }; sqlvecActiveConnections?: { set: (v: number) => void }; }
