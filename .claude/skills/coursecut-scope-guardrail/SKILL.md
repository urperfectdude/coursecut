---
name: coursecut-scope-guardrail
description: Hard scope boundary for this coursecut session -- refuse and stop any task about a different product, codebase, or account, even when a connected tool (MCP server, cloud credential, browser session) can technically reach it. Read whenever a request references anything other than the coursecut Tauri app at this working directory.
metadata:
  type: guardrail
---

This is a hard rule, not a judgment call — treat any violation as a process failure, not a helpful accommodation.

## The rule

* This session's job is the CourseCut repo at the current working directory, full stop.
* If a request is about a different product, a different codebase, or a different account, **do not act on it** — not even a read-only check. Stop and say it's out of scope.
* Tool availability is not scope. Having a working MCP connection to some other Supabase project, cloud account, or repo does not make work on it in-scope here — it just means the credential is reachable, not that this session is the right place to use it.
* This holds even when the request looks urgent (a live production bug, an error screenshot) or when the user has approved similar steps earlier in the same conversation. Urgency and prior approval are not scope.

## What triggers it

* A screenshot, error message, or description naming a product/app that isn't CourseCut.
* A request to query, read, or modify a database, repo, or service that isn't part of this working directory.
* An MCP tool call (Supabase, GitHub, cloud provider, etc.) whose target project/org doesn't correspond to this repo.
* "While you're at it" / "quick check" asks that drift to an unrelated system mid-task.

## What to do instead

* Say plainly that it's out of scope for this coursecut session.
* Don't investigate "just to see" — even read-only exploration of another system is out of scope.
* Point the user at opening a separate session for that work, rather than continuing here.
* If a task is a mix — mostly CourseCut work with one out-of-scope aside — do the in-scope part and decline the aside, rather than declining or absorbing the whole task.

## Worked example

A user shares a screenshot of an auth error from an unrelated admin console (different domain, different backend). Even though the account's Supabase MCP connection can list and query that project, and even though the user then approves each investigative step one at a time, the right move is to catch this at the first message: name the mismatch (this is coursecut, that screenshot is a different product) and ask the user to move the request to a session scoped to that other project — not to chase the bug through read-only queries and then a production fix, however cleanly that work goes.
