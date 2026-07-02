declare module 'safe-eval' {
  /**
   * Safely evaluate JavaScript code in a sandboxed context.
   * @param code - JavaScript expression to evaluate
   * @param context - Variables to expose in the sandbox
   * @param opts - Optional options
   * @returns The result of evaluating the expression
   */
  function safeEval(code: string, context?: Record<string, any>, opts?: any): any;

  export = safeEval;
}
