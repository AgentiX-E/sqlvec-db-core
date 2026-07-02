// Stub — real implementation in sqlvec-db-node
type OpsCommandConstructor = new (...args: any[]) => any;
export const OpsCommands: Record<string, OpsCommandConstructor> = {
  _stub: class { constructor(..._args: any[]) {} }
};
