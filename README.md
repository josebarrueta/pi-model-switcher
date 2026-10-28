# pi-model-switcher

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

## Retry handling and observability

Pi 1.4's low-level agent loop does not honor continuation on error turns. For a recoverable rate limit, the extension uses the supported `message_end` replacement hook to finalize an empty, tool-free response. At `turn_end`, it selects the fallback, omits the failed response from future model context with a context edit, records the original error in a `model-switcher.failover` custom session entry, and requests one continuation. This avoids native retry budgets and backoff preventing an exhaustive, bounded pass through the pool.

Final errors are left intact and abort the operation to prevent native retries. Stops are recorded as `model-switcher.stop` entries. Interactive/RPC clients also receive notifications; non-interactive clients can inspect session entries and model changes. The extension itself writes no separate configuration or credentials.

Detection uses the final HTTP failure status when the transport exposes it, otherwise explicit `429`, `rate_limit_error`, `rate limit`, or `too many requests` error text. Rate-limit errors inside successful HTTP streams are also recognized. Generic overload or quota messages without those signals are not treated as 429s.

Keep Pi's `retry.provider.maxRetries` at its default `0` for immediate failover. Provider-internal retries, when explicitly enabled, happen before this extension can observe the finalized error. Compaction summaries and nested extension model calls are not independently retried by this extension.

## Development

```sh
npm install --ignore-scripts
npm run check
npm test
```

Tests run Pi's real agent loop against an in-memory simulated transport, with native retries enabled. They make no provider requests. They cover provider preference, bounded exhaustion, scoped pools, retained tool results, cancellation, other errors, and reset between tasks.

The original throwaway state demo is archived on the [`prototype/failover`](https://github.com/josebarrueta/pi-model-switcher/tree/prototype/failover) branch as `failover.prototype.html`. The verdict was to preserve task context, prefer another provider after a 429, exclude failed models for the task, and stop on exhaustion. The production branch and installable package contain only the implementation.
