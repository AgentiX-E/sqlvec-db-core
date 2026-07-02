export class IdleTxnTimeoutManager { 
  startTimer() { return { cancel: () => {} }; } 
  cancelTimer() {} 
}
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 0;
