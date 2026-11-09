# mumbo boxes: personal assistant and project coordinator (stage 10 proposal)

Status: proposal for the founder, 2026-11-09. Builds on stages 8 (child sandboxes) and 9 (the box as the user's computer). Nothing here is built yet. The four decisions at the end are the founder's.

## What the user gets

- **One assistant per user,** always reachable at `boxes.mumbo.si`. It knows the user's accounts, files and projects, acts in the user's browser when permitted, and runs scheduled work while the user is away.
- **Projects,** each with its own coordinator agent and its own sandbox. The user asks the assistant ("start a landing page for X", "update the API project", "what's the status of everything?"); the assistant hands the work to the project's coordinator and reports back.

## Roles

| Role | Runs where | Has | Never has |
|---|---|---|---|
| **Assistant** | One durable dsh session in the user's box, the home session | Browser tools on the user's Chromium (signed-in accounts), schedule tools, a goal per standing task, subagent tools to start and message coordinators, read access to each project's status | Project code execution in the box beyond the user's own files |
| **Coordinator** (one per project) | A durable dsh subagent session in the user's box, started by the assistant (`subagent-spawn-in-process`, so it keeps its session for later messages) | The sandbox tools (stage 8) scoped to its project's sandbox, the team task board for that project, its own goal | Browser tools, the user's accounts, other projects' sandboxes |
| **Project sandbox** | An E2B sandbox outside the box (stage 8), one per project | The project's code, dependencies, running services | Any credential of the user's; anything outside its project |

Why the coordinator lives in the box and the code lives outside: one dsh per user keeps sessions, approvals and history in one place, while the code that installs packages and runs builds never shares a machine with the signed-in browser.

## Flows

1. **Start a project.** The user asks the assistant. The assistant spawns a coordinator subagent named after the project and messages it the brief. The coordinator calls `sandbox_create` with a project tag, sets up the repo, and reports progress to the assistant.
2. **Work on it.** The coordinator plans on its team board, runs commands and edits files in the project sandbox through the sandbox tools, and fans work out to extra short-lived sandboxes for parallel tasks (the 10-per-user cap of stage 8 applies across all projects).
3. **Status.** The assistant asks each coordinator, or reads their boards, and summarizes.
4. **Away from the keyboard.** A scheduled task on the assistant ("every morning, check the deploy and my inbox") wakes the box (stage 9 wake-on-schedule); the assistant does the work and leaves a summary for the next visit.
5. **Acting with an account.** The assistant uses the user's Chromium. Each action that posts, sends, buys or changes account settings asks the user first unless the user allowed that site and action kind; every such action is logged with site, action and outcome.

## What has to be built

| Piece | Where | Notes |
|---|---|---|
| Project sandboxes that persist | edge `sandboxes.mjs` | Today children are killed on timeout and not backed up. Projects need `project` metadata, pause instead of kill (`lifecycle.onTimeout: pause`), resume on use, and backups under `users/<hash>/projects/<id>/`. Short-lived helpers keep today's behavior. |
| Project-scoped sandbox tools | edge MCP | `project_create`, `project_list`, `project_open` (resume and return its id), plus the existing tools accepting a project id; a coordinator is given only its project. |
| Assistant preset | dsh overlay written by the box start script | Composes browser-use, schedule, goal, subagent with the in-process spawn provider, and a system prompt for the assistant role. |
| Coordinator preset | same overlay | Sandbox MCP tools, team board, goal; no browser-use. |
| Consent and audit | dsh approval answerer (in-box plugin) | Per-site, per-action-kind allow list; an audit line per account action. First verify what dsh approvals already ask for MCP browser calls (needs the DNS cutover to test in a real box). |
| Home view | web client | The assistant session first, a projects panel, a link to the desktop live view. |

Order: persistent project sandboxes and project tools (edge only, testable now) → presets (box start script) → consent → home view.

## Decisions for the founder

1. **Project sandboxes persist** (paused with memory when idle, backed up) — recommended — **or are disposable** (rebuilt from the repo each time; cheaper, slower to resume, nothing lost only if everything is in git).
2. **Coordinators run in the user's box** (one dsh, recommended) **or inside each project sandbox** (each project fully self-contained, but each sandbox then needs its own model access and the user's approvals in several places).
3. **Default for account actions:** ask every time until the user allows a site (recommended), or allow reads and ask for writes only.
4. **"Always on" means scheduled wake-ups** (box paused between tasks, recommended) **or a box that never pauses** (instant, about $40–60 a month per user at 4 GiB).
