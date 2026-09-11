/** Recorder admission/evidence bookkeeping, never a session engine or retry loop. */
export class CaptureState {
  private sendAdmitted = false;
  private attemptedWrites = 0;
  private observedWrites = 0;
  private possibleTurnWrite = false;
  private outboundObserverFailed = false;
  readonly observerErrors: string[] = [];

  admitSend() { this.sendAdmitted = true; }
  observe(fn: () => void) {
    try { fn(); } catch { this.observerErrors.push("observation-failed"); }
  }
  write(data: string, observe: (data: string) => boolean, forward: (data: string) => void) {
    this.attemptedWrites++;
    try {
      const provenNonTurn = observe(data);
      this.observedWrites++;
      if (!provenNonTurn) this.possibleTurnWrite = true;
    } catch {
      this.outboundObserverFailed = true;
      this.observerErrors.push("outbound-observation-failed");
    }
    // Preserve exactly one original transport write and its original exception.
    forward(data);
  }
  noTurn() {
    return !this.sendAdmitted && !this.possibleTurnWrite && !this.outboundObserverFailed
      && this.attemptedWrites === this.observedWrites;
  }
  cleanupAllowed(nativeTerminalObserved: boolean, processExited: boolean) {
    return nativeTerminalObserved || processExited || this.noTurn();
  }
  snapshot() {
    return { sendAdmitted: this.sendAdmitted, attemptedWrites: this.attemptedWrites,
      observedWrites: this.observedWrites, possibleTurnWrite: this.possibleTurnWrite,
      outboundObserverFailed: this.outboundObserverFailed, noTurn: this.noTurn() };
  }
}
