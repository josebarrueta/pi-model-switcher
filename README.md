# pi-model-switcher

[![CI](https://github.com/josebarrueta/pi-model-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/josebarrueta/pi-model-switcher/actions/workflows/ci.yml)

A Pi extension that continues the current task on another model after HTTP 429 / rate-limit errors. Requires Pi 1.4.0 or newer with the current extension boundary API.

## Install

Install from GitHub for future Pi sessions:

```sh
pi install git:github.com/josebarrueta/pi-model-switcher
```

Or pin the initial release:

```sh
pi install git:github.com/josebarrueta/pi-model-switcher@v0.1.0
```

Restart Pi or run `/reload` in an existing session. Use `pi install --local` instead to install for the current project only.

To try it for one invocation without installing:

```sh
pi -e git:github.com/josebarrueta/pi-model-switcher
```

### Local development

From a clone of this repository:

```sh
pi -e ./src/index.ts
```

Or install the local package for future sessions:

```sh
pi install /absolute/path/to/pi-model-switcher
```

No build step or runtime dependencies are needed. Log in to the providers you want to use with Pi's `/login` first.

## Policy

- Start with your selected physical model. No special router model to select.
- Snapshot available, credential-configured models when a task starts. Honor `--models` / `enabledModels` scopes, and exclude virtual models.
- On a 429, prefer an untried model from a different provider, then try the remaining models in registry order.
- Never return to a rate-limited model during the same task, including after successful tool calls. Model identities include both provider and model ID.
- Continue the same conversation and retain completed tool results. The extension does not rerun tools, although a model can independently request a similar action again.
- Stop the current operation when every eligible model is rate-limited, on other errors, or on cancellation. Pi stays open. Native agent retries are suppressed for these failures.
- A new prompt after settlement starts a fresh task and clears exclusions. Steering within a running task does not clear them. The last selected fallback remains selected.
- Leave existing virtual-model selections alone; they own their routing policy.

**Switching providers sends the conversation and tool results to the fallback provider and can incur different costs.** Limit the pool to trusted models using Pi's `--models` option or scoped-model settings. Without a scope, every available physical chat model is eligible.

Example with the model IDs from your own `/model` list:

```sh
pi -e ./src/index.ts --models 'openai-codex/<your-codex-model>,anthropic/<your-claude-model>'
```

Configured credentials do not guarantee a model is usable. A missing permission, invalid credential, context overflow, or other non-rate-limit failure stops the task rather than probing more models.

## Example

Illustrative task with three eligible models:

```text
Codex primary    → 429: excluded for this task
Claude           → completes a tool action; work is retained
Claude           → 429: excluded for this task
Codex alternate  → task completes
```

If Codex alternate also returns 429, the extension stops the operation. It does not return to Codex primary, restart the task, or exit Pi. Send a new prompt when you want to try again.

## Retry handling and observability

Pi 1.4's low-level agent loop does not honor continuation on error turns. For a recoverable rate limit, the extension uses the supported `message_end` replacement hook to finalize an empty, tool-free response. At `turn_end`, it selects the fallback, omits the failed response from future model context with a context edit, records the original error in a `model-switcher.failover` custom session entry, and requests one continuation. This avoids native retry budgets and backoff preventing an exhaustive, bounded pass through the pool.

Final errors are left intact and abort the operation to prevent native retries. Stops are recorded as `model-switcher.stop` entries. Interactive/RPC clients also receive notifications; non-interactive clients can inspect session entries and model changes. The extension itself writes no separate configuration or credentials.

Detection uses the final HTTP failure status when the transport exposes it, otherwise explicit `429`, `rate_limit_error`, `rate limit`, or `too many requests` error text. Rate-limit errors inside successful HTTP streams are also recognized. Generic overload or quota messages without those signals are not treated as 429s.

Keep Pi's `retry.provider.maxRetries` at its default `0` for immediate failover. Provider-internal retries, when explicitly enabled, happen before this extension can observe the finalized error. Compaction summaries and nested extension model calls are not independently retried by this extension.

## Validation and CI

GitHub Actions runs on pushes to `main`, pull requests, and manual dispatch. It checks **Node 22.19.0** (the minimum supported version) and **Node 24**. Each job:

1. Installs locked dependencies with `npm ci --ignore-scripts`.
2. Type-checks the extension and test harness.
3. Runs the mocked-provider integration tests.
4. Uploads JUnit XML reports, including after test failures when reports are available.
5. Checks the distributable contents with `npm pack --dry-run`.

**No provider credentials, GitHub secrets, or paid model calls are required.** Dependency installation still needs registry access. Model catalog networking is disabled in the harness; Pi's background network activity and telemetry are disabled in CI.

### What is mocked?

[`test/failover.test.ts`](test/failover.test.ts) creates a real Pi SDK session with an in-memory conversation, temporary credential storage, dummy runtime keys, and scoped models. Only the external model transport is replaced. Mock responses pass through Pi's normal message events, extension hooks, tool execution, model switching, continuation, and native retry handling.

Fixtures support simple responses and explicit HTTP metadata:

```ts
// First model rejects the request; a different provider completes the task.
await harness([{ status: 429, error: "Provider rejected the request" }, "ok"]);

// A rate-limit error can also arrive inside an HTTP-success stream.
await harness([{ status: 200, error: "rate_limit_error: please retry later" }, "ok"]);

// Every eligible model is rate-limited: stop after exactly three requests.
await harness(["429", "429", "429"]);
```

These examples use the test-local `harness` helper; they are not public plugin configuration. Each test cleans up its temporary session files and asserts that every expected response was consumed, no unexpected requests occurred, and no extension handler errors were swallowed. Tests have a 15-second timeout to catch hangs.

### Covered scenarios

| Mock response / condition | Expected result |
| --- | --- |
| 429 followed by success | Switch provider; retain the original prompt |
| HTTP 429 with an opaque error body | Recognize the status and switch |
| HTTP 200 containing a streamed rate-limit error | Switch based on the error text |
| HTTP 400/401/403/500/503 quoting an earlier 429 | Stop; HTTP failure status takes precedence |
| Every scoped model returns 429 | Try each once; stop despite native retries being enabled |
| Only same-provider alternatives remain | Try another model from that provider |
| Only one eligible model | Stop after its first 429; do not escape the scope |
| A tool action completes before a 429 | Retain its result without replaying the tool |
| Fallback credentials disappear after the task starts | Stop safely without sending a fallback request |
| Model returns an abort / user cancels before a late 429 | Do not continue or switch models |
| New prompt after exhaustion | Clear exclusions and allow recovery |

This validates the extension against **Pi 1.4.0's real agent loop**, not live OpenAI/Anthropic services. It does not verify provider SDK retry behavior, actual account quotas, terminal rendering, or future Pi API compatibility.

### Run locally

```sh
npm ci --ignore-scripts
npm run check
npm test

# Same test reporters as GitHub Actions:
npm run test:ci
```

Reports are written to `test-results/junit.xml` (ignored by Git). On GitHub, open **Actions → CI → a run → Artifacts** to download reports for each Node version. Use **Run workflow** to validate `main` manually.

To run one scenario:

```sh
node --experimental-strip-types --test --test-name-pattern='HTTP 429 metadata' test/failover.test.ts
```

### Troubleshooting

- **No model switch:** confirm you selected a physical model, configured fallback provider credentials via `/login`, and included fallback models in your scope. Generic quota or overload errors without a 429/rate-limit signal are intentionally not retried.
- **Switching takes a long time:** leave `retry.provider.maxRetries` at `0`; provider-internal retries delay finalized error events.
- **A fallback fails with 401/403 or context overflow:** the task stops by design. Fix access or context size before submitting a new prompt.
- **Unexpected provider receives context:** scope your allowed models explicitly. Without a scope, all available physical chat models are candidates.
- **CI fails:** inspect the job's type-check/test output and downloaded reports. Do not add real credentials to make mocked tests pass.

The original throwaway state demo is archived on the [`prototype/failover`](https://github.com/josebarrueta/pi-model-switcher/tree/prototype/failover) branch as `failover.prototype.html`. The verdict was to preserve task context, prefer another provider after a 429, exclude failed models for the task, and stop on exhaustion. The production branch and installable package contain only the implementation.
