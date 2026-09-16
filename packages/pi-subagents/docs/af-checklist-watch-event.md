# af-checklist-watch launch event

`af-checklist-watch` and this package share one fixed-purpose in-process event:

```text
pi:af-checklist-watch:v1:start
```

The request contains only:

- `version`
- `requestId`
- `cwd`
- `prompt`
- an optional `AbortSignal`
- `claim`, `respond`, and `complete` callbacks

The provider claims and acknowledges a valid request synchronously, then opens the child asynchronously. Completion is delivered once through the callback and is not inserted into the parent model conversation.

The provider owns the launch policy:

- interactive multiplexer session
- asynchronous parent behavior
- one-turn auto-exit
- parent model and thinking inheritance
- `read`, `bash`, `edit`, and `write`
- no skills, extensions, or child spawning
- standalone temporary child session
- no fixed wall-clock or idle timeout, so CI and deployment waits can finish
- termination on cancellation or parent close
- one right-side stack of split panes in Zellij
- mandatory JSONL audit logging for finalized messages, tool activity, direct operator input, and lifecycle events
- a trusted unattended-work policy: a finalized human approval authorizes its exact immediately downstream action, while unfinished human approval steps wait through AmpliFlow without requiring terminal attention

The request cannot override tools, model, execution budgets, environment, session policy, authorization policy, or execution mode. The provider rejects a missing interactive session, a mismatched working directory, an unavailable multiplexer, invalid input, cancellation before launch, or exhausted spawn capacity.

This event is a compatibility seam between two trusted installed extensions, not a public generic background-job protocol.
