import type { ToolDecision, ToolGate, ToolRequest } from './harness-session';

/**
 * A session's registered tool gates. They compose in registration order and the first deny
 * wins; a gate that throws or rejects denies. `pre-use` with no deny is no decision (the
 * runtime's own mode decides); `permission` with no gate registered is denied.
 */
export class ToolGates {
  private readonly _gates: ToolGate[] = [];

  get size(): number {
    return this._gates.length;
  }

  add(gate: ToolGate): () => void {
    this._gates.push(gate);
    return () => {
      const index = this._gates.indexOf(gate);
      if (index !== -1) this._gates.splice(index, 1);
    };
  }

  /** The gates in order, for a sibling session (fork). */
  list(): readonly ToolGate[] {
    return [...this._gates];
  }

  /**
   * Never rejects. Undefined means no decision: only a `pre-use` request without a deny, a new
   * input or context. A gate's `updatedInput` (pre-use) is the next gate's `toolInput` and the
   * decision's; each gate's `context` (pre-use) is kept, in order.
   */
  async decide(request: ToolRequest): Promise<ToolDecision | undefined> {
    const gates = [...this._gates];
    if (!gates.length)
      return request.stage === 'permission'
        ? { behavior: 'deny', message: 'No approval handler' }
        : undefined;
    let current = request;
    let updatedInput: Readonly<Record<string, unknown>> | undefined;
    const context: string[] = [];
    for (const gate of gates) {
      let decision: ToolDecision;
      try {
        decision = await gate(current);
      } catch (error) {
        return {
          behavior: 'deny',
          message: `Tool gate failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (decision?.behavior === 'deny')
        return { behavior: 'deny', message: String(decision.message ?? 'Denied') };
      if (decision?.behavior !== 'allow')
        return { behavior: 'deny', message: 'Tool gate failed: malformed decision' };
      if (decision.updatedInput !== undefined && request.stage === 'pre-use') {
        if (
          !decision.updatedInput ||
          typeof decision.updatedInput !== 'object' ||
          Array.isArray(decision.updatedInput)
        )
          return { behavior: 'deny', message: 'Tool gate failed: malformed updatedInput' };
        updatedInput = Object.freeze(structuredClone(decision.updatedInput));
        current = { ...current, toolInput: updatedInput };
      }
      if (decision.context !== undefined && request.stage === 'pre-use') {
        if (typeof decision.context !== 'string')
          return { behavior: 'deny', message: 'Tool gate failed: malformed context' };
        if (decision.context.trim()) context.push(decision.context);
      }
    }
    if (request.stage === 'permission') return { behavior: 'allow' };
    if (!updatedInput && !context.length) return undefined;
    return {
      behavior: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
      ...(context.length ? { context: context.join('\n\n') } : {}),
    };
  }
}

/** `mcp__<server>__<tool>` split into its server and method. */
export function mcpToolParts(toolName: string): { toolServer?: string; toolMethod?: string } {
  if (!toolName.startsWith('mcp__')) return {};
  const rest = toolName.slice(5);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return {};
  return { toolServer: rest.slice(0, split), toolMethod: rest.slice(split + 2) };
}
