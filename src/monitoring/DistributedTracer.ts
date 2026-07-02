export class DistributedTracer {
  static getInstance() { return new DistributedTracer(); }
  endSpan() {}; endTrace() {}; startSpan() { return this; }; startTrace() { return this; }
}
