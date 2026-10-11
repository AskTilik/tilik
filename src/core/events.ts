import type { Tier } from "../config/routing.js";
import type { Intent } from "../router/intent.js";
import type { UnifiedIntent } from "../router/unified.js";
import type { ToolRun } from "../tools/runner.js";
import type { PublicSource, VeyraResponse } from "../types/api.js";

/**
 * The streaming contract (SSE `event:` names). Safe to show to users: status
 * messages are fixed strings and no model reasoning is ever exposed.
 */
export type EngineEvent =
  | { type: "request.started"; requestId: string; at: string }
  | { type: "intent.detected"; requestId: string; intents: Intent[]; unified: UnifiedIntent[]; primary: Intent; method: "rules" | "llm" }
  | { type: "plan.created"; requestId: string; plan: VeyraResponse["plan"] }
  | { type: "status"; requestId: string; message: string }
  | { type: "tool.started"; requestId: string; step: string; capability: string; tool: string; label: string }
  | { type: "tool.completed"; requestId: string; run: ToolRun }
  | { type: "source.discovered"; requestId: string; source: PublicSource }
  /** Internal: everything retrieved and ranked (mapped to `sources` for the v1 stream format). */
  | { type: "context.ready"; requestId: string; sources: PublicSource[]; toolRuns: ToolRun[]; data: VeyraResponse["data"]; retrieval: VeyraResponse["retrieval"] }
  | { type: "model.selected"; requestId: string; provider: string; model: string; tier: Tier }
  | { type: "response.delta"; requestId: string; text: string }
  | { type: "response.completed"; requestId: string; response: VeyraResponse };

export type Emit = (e: EngineEvent) => void;

/** Single-consumer async queue bridging the pipeline (producer) and the SSE stream (consumer). */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting?: (v: IteratorResult<T>) => void;
  private failing?: (e: unknown) => void;
  private done = false;
  private error: unknown;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      this.failing = undefined;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.done = true;
    if (this.waiting) this.waiting({ value: undefined as never, done: true });
  }

  fail(err: unknown): void {
    this.error = err;
    this.done = true;
    if (this.failing) this.failing(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.failing = reject;
        });
      },
    };
  }
}
