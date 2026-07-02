declare module 'minisearch' {
  export default class MiniSearch {
    constructor(config: any);
    add(doc: any): void;
    remove(id: any): void;
    search(query: string, opts?: any): any[];
    addAll(docs: any[]): void;
  }
}
