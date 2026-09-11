import { SessionTurnError, type SessionAttempt, type SessionEvent, type SessionIdentity, type SessionResult } from "./harness-session";
import { retainEvidence } from "./retained-evidence";
/** Per-admission evidence. Caller settlement never transfers native ownership. */
export class TurnState {
  readonly admissionId = crypto.randomUUID();
  identity: SessionIdentity = {};
  nativeOutcome: SessionAttempt["nativeOutcome"] = "unknown";
  localOutcome: SessionAttempt["localOutcome"] = "pending";
  dispatch: SessionAttempt["dispatch"] = "not-dispatched";
  transportOutcome: SessionAttempt["transportOutcome"] = "open";
  private _terminal?: SessionAttempt["terminal"];
  get terminal() { return this._terminal; }
  set terminal(value: SessionAttempt["terminal"]) { this._terminal = retainEvidence(value); }
  events: SessionEvent[] = [];
  content = "";
  private _tokens?: { input: number; output: number };
  get tokens() { return this._tokens; }
  set tokens(value: { input: number; output: number } | undefined) { this._tokens = retainEvidence(value); }
  localFailure?: SessionAttempt["localFailure"];
  rpcSettled = false;
  rpcOutcome?: SessionAttempt["rpcOutcome"];
  snapshot(): SessionAttempt {
    return Object.freeze({ ...this.identity, admissionId: this.admissionId, nativeOutcome: this.nativeOutcome,
      localOutcome: this.localOutcome, dispatch: this.dispatch, transportOutcome: this.transportOutcome,
      rpcOutcome: this.rpcOutcome, terminal: this.terminal, localFailure: this.localFailure,
      content: this.content, events: Object.freeze([...this.events]), tokens: this.tokens });
  }
  result(externalSessionId?: string): SessionResult { return Object.freeze({ ...this.snapshot(), externalSessionId }); }
  fail(error: Error, reason: SessionAttempt["localFailure"]): SessionTurnError {
    if (this.localOutcome === "pending") { this.localOutcome = "rejected"; this.localFailure = reason; }
    return new SessionTurnError(error.message, () => this.snapshot(), { cause: error });
  }
  record(event: SessionEvent): SessionEvent {
    const e = retainEvidence({ ...this.identity, ...event, admissionId: this.admissionId });
    this.events.push(e);
    if ((e.kind === "text" || e.kind === "result") && e.text) this.content = e.text;
    if (e.kind === "text_delta" && e.text) this.content += e.text;
    if (e.tokens) this.tokens = e.tokens;
    return e;
  }
}
