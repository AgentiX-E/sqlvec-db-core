declare module 'jieba-wasm' {
  export function cut(text: string, hmm?: boolean): string[];
  export function extract(text: string, topk: number): { word: string; weight: number }[];
}
