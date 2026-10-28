import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export function isRateLimit(error: string | undefined, status?: number): boolean {
  // An HTTP failure status beats text that may quote earlier errors. A 2xx
  // response can still contain a rate-limit error inside its event stream.
  if (status !== undefined && status >= 400) return status === 429;
  return /\b429\b|\brate[ _-]?limit(?:ed|ing|s|[ _-]error|[ _-]exceeded)?\b|\btoo many requests\b/i.test(error ?? "");
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
  const scoped = new Set(ctx.scopedModels.map(({ model }) => key(model)));
  const seen = new Set<string>();
  return ctx.modelRegistry.getAvailable().filter((model) => {
    const id = key(model);
    if (model.api === "pi-virtual" || seen.has(id) || (scoped.size > 0 && !scoped.has(id))) return false;
    seen.add(id);
    return true;
  });
}

export default function modelSwitcher(pi: ExtensionAPI): void {
  let candidates: Model<Api>[] = [];
  const limited = new Set<string>();
  let status: number | undefined;
  let active = false;
  let pending: { message: AssistantMessage; next: Model<Api>; error: string } | undefined;

  function reset(): void {
    candidates = [];
    limited.clear();
    pending = undefined;
    status = undefined;
    active = false;
  }

  function notify(ctx: ExtensionContext, message: string, severity: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, severity);
  }

  function stop(ctx: ExtensionContext, reason: string): void {
    active = false;
    pending = undefined;
    pi.appendEntry("model-switcher.stop", { reason, limited: [...limited] });
    notify(ctx, reason, "error");
    // Cancels native retries and queued automatic work; does not exit Pi.
    ctx.abort();
  }

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("before_agent_start", (_event, ctx) => {
    reset();
    // Do not interfere with another extension's virtual-model routing policy.
    if (!ctx.model || ctx.model.api === "pi-virtual") return;
    candidates = availableModels(ctx);
    active = true;
  });

  pi.on("turn_start", () => { status = undefined; });
  pi.on("before_provider_request", () => { status = undefined; });
  pi.on("after_provider_response", (event) => { status = event.status; });

  pi.on("message_end", (event, ctx) => {
    if (!active || ctx.signal?.aborted || event.message.role !== "assistant") return;
    const message = event.message;
    if (message.stopReason !== "error" || !isRateLimit(message.errorMessage, status)) return;

    limited.add(key({ provider: message.provider, id: message.model }));
    // A snapshot bounds attempts even if the registry changes during the task.
    const remaining = candidates.filter((model) => !limited.has(key(model)));
    const next = remaining.find((model) => model.provider !== message.provider) ?? remaining[0];
    if (!next) return; // Keep the final error intact; turn_end aborts native retry.

    pending = { message, next, error: message.errorMessage ?? "HTTP 429" };
    // In Pi 1.4, error turns ignore boundary continuation and enter native retry.
    // Finalize an inert, tool-free response instead. turn_end omits it from model
    // context, records the original error, and explicitly requests one next turn.
    return { message: { ...message, content: [], stopReason: "stop", errorMessage: undefined } };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    if (ctx.signal?.aborted || event.message.stopReason === "aborted") {
      active = false;
      pending = undefined;
      return;
    }

    const recovery = pending;
    pending = undefined;
    if (recovery && recovery.message === event.message) {
      try {
        if (!(await pi.setModel(recovery.next))) {
          stop(ctx, `Failover stopped: credentials unavailable for ${key(recovery.next)}.`);
          return;
        }
      } catch (error) {
        stop(ctx, `Failover stopped: could not select ${key(recovery.next)}: ${String(error)}`);
        return;
      }
      if (ctx.signal?.aborted) return;
      const from = `${event.message.provider}/${event.message.model}`;
      notify(ctx, `429 from ${from}; continuing with ${key(recovery.next)}.`, "warning");
      return {
        entries: [
          ...event.entries,
          { type: "context_edit" as const, targetId: event.messageEntryId, replacement: null },
          {
            type: "custom" as const,
            customType: "model-switcher.failover",
            data: { from, to: key(recovery.next), error: recovery.error },
          },
        ],
        continue: true,
      };
    }

    if (event.message.stopReason === "error") {
      const reason = isRateLimit(event.message.errorMessage, status)
        ? `Failover stopped: all ${candidates.length} eligible models are rate-limited; no more requests.`
        : "Failover stopped: non-rate-limit error; no automatic retries.";
      stop(ctx, reason);
    }
  });

  pi.on("agent_settled", () => { active = false; pending = undefined; });
}
