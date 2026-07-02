export type TDEAlgorithm = 'aes-256-gcm' | 'aes-192-gcm' | 'aes-128-gcm';
export class TDEConfig {
  enabled = false; algorithm: TDEAlgorithm = 'aes-256-gcm'; key?: string;
  static loadFromEnv() { return new TDEConfig(); }
  static setPoliciesDir(_d: string) {}; static initFromEnv(_d: string) {}; static validateKey(_k: any) { return true; }
}
