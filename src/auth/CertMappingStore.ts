export class CertMappingStore { 
  static getInstance() { return new CertMappingStore(); }
  static create() { return new CertMappingStore(); }
  map(_cn: string) { return undefined; }
}
