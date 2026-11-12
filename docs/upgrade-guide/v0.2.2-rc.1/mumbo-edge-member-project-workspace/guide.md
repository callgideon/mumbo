---
kind: upgrade-guide
description: "The `@mumbo/edge-member` row now requires a `workspace` key and the `sessionPersistence` service, and grants members the Workspace role only on that one Workspace, so a composition without the key no longer admits members."
---

# `@mumbo/edge-member` names the project Workspace

## Change

[`@mumbo/edge-member`](../../../../packages/mumbo/edge-member/README.md#configuration) takes a required `workspace`, the canonical path of the project Workspace. Members follow and start Sessions only in the Workspace stored at exactly that path; before, they held that role on every Workspace. They now also hold the Session role on every stored Session, so Sessions with no Workspace and finished subagent children stay reachable. The plugin injects `sessionPersistence` and lists the stored Sessions when it loads.

The new [`@mumbo/edge-member/project-workspace`](../../../../packages/mumbo/edge-member/README.md#project-workspace) row registers that directory as a Workspace while the Host starts and again after a deletion.

Affected: compositions that mount `@mumbo/edge-member`, such as a project box's overlay. A row without `workspace` fails at load, and no member is admitted.

## Migration

1. In the `mumbo-edge-member` row, add `workspace:` with the project directory's realpath, for example `!!js process.env.HOME + '/projects'` as [`deploy/mumbo-project.overlay.yml`](../../../../deploy/mumbo-project.overlay.yml) sets it.
2. Insert a `mumbo-project-workspace` row named `@mumbo/edge-member/project-workspace` with the same `workspace` value, after the member row.
3. Keep a Session persistence row in the composition; every Web profile has one.
4. Confirm the migration: start the deployment, check that the log reports no failed `mumbo-edge-member` or `mumbo-project-workspace` entry, and open the page as a member. It opens a blank Session in the project Workspace and shows no "Unable to create default workspace" notice.
