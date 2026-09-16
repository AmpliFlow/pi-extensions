---
"@narumitw/pi-subagents": patch
---

Remove the fixed checklist-worker timeout so long CI and deployment waits can finish. Keep cancellation and parent shutdown authoritative, including when a pane launch finishes during shutdown, and report cancelled runs with an explicit cause.
