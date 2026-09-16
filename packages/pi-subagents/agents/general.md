---
name: general
description: Handle a bounded delegated task that may require reading, commands, and file edits.
mode: interactive
async: true
auto-exit: true
tools: read,grep,find,ls,bash,edit,write
skills: all
extensions: all
spawning: false
session-mode: standalone
parent-close-policy: terminate
---
Complete the delegated task directly. Keep scope bounded and return the result, changed files, and checks.
