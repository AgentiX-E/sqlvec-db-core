declare module 'piscina' {
  export default class Piscina { constructor(_opts: any); run(_task: any, _opts?: any): Promise<any>; destroy(): Promise<void>; }
}
