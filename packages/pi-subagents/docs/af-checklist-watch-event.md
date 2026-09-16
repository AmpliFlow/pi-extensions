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
- 900-second timeout
- termination on parent close

The request cannot override tools, model, timeout, environment, session policy, or execution mode. The provider rejects a missing interactive session, a mismatched working directory, an unavailable multiplexer, invalid input, cancellation before launch, or exhausted spawn capacity.

This event is a compatibility seam between two trusted installed extensions, not a public generic background-job protocol.
