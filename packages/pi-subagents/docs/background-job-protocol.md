# Background-job event protocol

Pi Subagents exposes its existing runtime to other trusted Pi extensions through the shared `pi.events` bus. This lets an extension start isolated work without implementing another child-process runner.

## Start event

Emit `pi:background-job:v1:start` with one object:

```ts
{
  version: 1,
  requestId: string,
  task: string,
  cwd: string,
  tools?: string[],
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  timeout?: number,
  signal?: AbortSignal,
  claim(): boolean,
  respond(response): void,
  complete(completion): void,
}
```

`claim` must return `true` only once. It prevents duplicate work if more than one compatible provider is loaded. After synchronous event delivery, no successful claim means that no provider is active.

The provider calls `respond` synchronously with either:

```ts
{ ok: true, jobId: string, state: "queued" }
{ ok: false, error: string }
```

A successful request receives exactly one later `complete` callback:

```ts
{
  jobId: string,
  state: "completed" | "partial" | "failed" | "timed_out" | "cancelled",
  result?: string,
  error?: string,
  limitations?: string[],
}
```

Aborting `signal` cancels the matching job. Session shutdown also cancels it. The normal subagent limits, validation, queue, concurrency control, model inheritance, credential checks, retention, and result bounds still apply.

## Trust boundary

This is an in-process extension protocol, not a permission boundary. Only enable extensions you trust with your user account. The provider accepts requests only for the active Pi session's exact working directory. Child tools remain limited to the requested names and Pi's fixed child communication tools.

The task is untrusted model input. A caller must bind any application identity in its own task and verify outcomes against its authoritative source after completion.
