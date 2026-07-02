export interface HbaRecord { type: string; database: string; user: string; address: string; method: string; options: Record<string,string> }
export class PgHbaConf {
  static load() { return new PgHbaConf(); }
  getRules(): HbaRecord[] { return []; }
}
