import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import switcher, { isRateLimit } from "../src/index.ts";

// Real Pi agent loop, fake model transport: no provider requests or personal credentials.
async function harness(replies: ("429" | "ok" | "500" | "aborted" | "tool")[], count = 3) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-switcher-test-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json") });
  await runtime.setRuntimeApiKey("openai", "test-not-a-real-key");
  await runtime.setRuntimeApiKey("anthropic", "test-not-a-real-key");
  const openai = runtime.getModels("openai").slice(0, 2);
  const anthropic = runtime.getModels("anthropic").slice(0, 1);
  assert.equal(openai.length, 2);
  assert.equal(anthropic.length, 1);
  const models = [...openai, ...anthropic].slice(0, count);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 10, baseDelayMs: 1 },
  });
  const effects = { completed: 0 };
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [switcher, pi => {
      pi.registerTool({
        name: "complete_action", label: "Complete action", description: "Complete a simulated action",
        parameters: Type.Object({}),
        execute: async () => {
          effects.completed++;
          return { content: [{ type: "text", text: "Action completed" }], details: undefined };
        },
      });
    }],
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, model: models[0],
    scopedModels: models.map(model => ({ model, thinkingLevel: "off" })),
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    noTools: "builtin", thinkingLevel: "off",
  });
  const calls: string[] = [];
  const contexts: Context[] = [];
  const errors: unknown[] = [];
  session.agent.streamFunction = (model, context) => {
    calls.push(`${model.provider}/${model.id}`);
    contexts.push(structuredClone(context));
    assert.ok(calls.length <= 12, "failover loop exceeded the eligible model count");
    const reply = replies.shift() ?? "500";
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", content: reply === "tool"
        ? [{ type: "toolCall", id: "action-1", name: "complete_action", arguments: {} }]
        : reply === "ok" ? [{ type: "text", text: "Done" }] : [],
      provider: model.provider, api: model.api, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reply === "tool" ? "toolUse" : reply === "ok" ? "stop" : reply === "aborted" ? "aborted" : "error",
      ...(reply !== "ok" && reply !== "tool" ? { errorMessage: reply === "429" ? "429 Too Many Requests" : "500 Internal Server Error" } : {}),
      timestamp: Date.now(),
    };
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: reply === "tool" ? "toolUse" : "stop", message });
    }
    stream.end();
    return stream;
  };
  await session.bindExtensions({ onError: error => errors.push(error) });
  return {
    session, calls, contexts, errors, models, effects,
    async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("detects 429 and provider rate-limit errors, not arbitrary failures", () => {
  for (const message of ["HTTP 429", "rate_limit_error", "rate limit exceeded", "Too Many Requests"]) assert.equal(isRateLimit(message), true);
  for (const message of ["500 overload", "401 Unauthorized", "quota exceeded", undefined]) assert.equal(isRateLimit(message), false);
  assert.equal(isRateLimit("unrelated text", 429), true);
  assert.equal(isRateLimit("previous error: 429", 500), false);
  assert.equal(isRateLimit("rate_limit_error", 200), true);
});

test("429 switches provider and continues original prompt without failed response", async () => {
  const h = await harness(["429", "ok"]);
  try {
    await h.session.prompt("Continue this same task");
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].startsWith("openai/"));
    assert.ok(h.calls[1].startsWith("anthropic/"));
    assert.equal(h.session.getLastAssistantText(), "Done");
    assert.equal(h.contexts[1].messages.filter(m => m.role === "user").length, 1);
    assert.equal(h.contexts[1].messages.filter(m => m.role === "assistant").length, 0);
    assert.deepEqual(h.errors, []);
    assert.ok(h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "model-switcher.failover"));
  } finally { await h.close(); }
});

test("exhaustion tries each eligible model once even with native retries enabled", async () => {
  const h = await harness(["429", "429", "429"]);
  try {
    await h.session.prompt("Do work");
    assert.equal(h.calls.length, 3);
    assert.equal(new Set(h.calls).size, 3);
    assert.ok(h.calls[1].startsWith("anthropic/"));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("completed tool actions survive failover without being replayed", async () => {
  const h = await harness(["tool", "429", "ok"]);
  try {
    await h.session.prompt("Complete one action and report back");
    assert.equal(h.effects.completed, 1);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[0], h.calls[1]);
    assert.ok(h.calls[2].startsWith("anthropic/"));
    const results = h.contexts[2].messages.filter(m => m.role === "toolResult");
    assert.equal(results.length, 1);
    assert.deepEqual(h.errors, []);
    assert.equal(h.session.getLastAssistantText(), "Done");
  } finally { await h.close(); }
});

test("one eligible model stops on its first 429", async () => {
  const h = await harness(["429"], 1);
  try { await h.session.prompt("Do work"); assert.equal(h.calls.length, 1); }
  finally { await h.close(); }
});

test("non-429 errors do not trigger failover or native retries", async () => {
  const h = await harness(["500"]);
  try { await h.session.prompt("Do work"); assert.equal(h.calls.length, 1); }
  finally { await h.close(); }
});

test("aborted requests do not switch models", async () => {
  const h = await harness(["aborted"]);
  try { await h.session.prompt("Do work"); assert.equal(h.calls.length, 1); }
  finally { await h.close(); }
});

test("a fresh prompt resets exhausted models and can recover", async () => {
  const h = await harness(["429", "429", "429", "429", "ok"]);
  try {
    await h.session.prompt("First task");
    assert.equal(h.calls.length, 3);
    await h.session.prompt("New task");
    assert.equal(h.calls.length, 5);
    assert.equal(h.session.getLastAssistantText(), "Done");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
