# Upstream copy and modification log

`@mumbo/superagent` is a pinned copy of https://github.com/deepseek-ai/dsh-superagent-prototype at commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, MIT licensed (see `LICENSE`).

Every change to the copy is an entry below. A path outside `packages/mumbo/superagent/` that exists for the copy is listed too. Oxlint ignores `packages/mumbo/superagent/**`. Task A2 adds the remaining gate exclusions, each commented `pinned upstream copy; see packages/mumbo/superagent/UPSTREAM.md`.

## S1: port and packaging

Upstream targets dsh `0.2.1-alpha.2` and builds as a standalone package. The copy builds inside this repository at `0.2.2-rc.1`.

Files not copied: upstream `tsdown.config.ts`, `vitest.config.ts`, `pnpm-lock.yaml`, `scripts/` and `tests/service-script.spec.ts`. Upstream `README.md` is `docs/upstream-readme.md`.

Added: `package.json`, `tsconfig.json`, `tsconfig.host.json`, `tsconfig.client.json`, `tsdown.config.ts`, `src/client/css-modules.d.ts` (replaces `src/client/css.d.ts`) and this file.

Edits to the copy:

- `package.json`: private `@mumbo/superagent` at the repository version `0.2.2-rc.1`; `workspace:*` and `workspace:~` dependency ranges; the packages `cordis.patch.yml` names are `dependencies`; `@deepseek-ai/dsh-client-connection` as peer and dev dependency; `lib/types` declarations.
- `tsconfig.json` is solution-only. `tsconfig.host.json` and `tsconfig.client.json` turn off `exactOptionalPropertyTypes`, `noUnusedLocals` and `noUnusedParameters`, which upstream never enabled (commented in each file). The host leaf excludes `src/client` and `src/navigation.ts` (client only). The client leaf includes all of `src` with Node types and the union of both leaves' references, because the shared client modules import host view types; it does not reference the host leaf.
- `src/index.ts`: `import type {} from '@deepseek-ai/dsh-client-connection'`.
- `src/infra/paths.ts`: `packageRoot()` matches `@mumbo/superagent`.
- `cordis.patch.yml`: the plugin row names are `@mumbo/superagent`, `@mumbo/superagent/github-watch` and `@mumbo/superagent/feishu-watch`. Row ids and preset ids are unchanged.
- `src/client/provider.tsx`: the stylesheet import is `?inline`, as `packages/client/tsdown.client.ts` provides.
- Documentation links in `src/deployment.ts`, `src/setup.ts`, `src/app/http.ts` and `src/client/locales.ts` are relative to the repository root (`packages/mumbo/superagent/docs/...`).
- `docs/007-architecture.md` lists `css-modules.d.ts` and no longer lists `tests/service-script.spec.ts`. `tests/docs.spec.ts` checks `SETUP.md` as the only entry document because the package has no `README.md`.
- Tests that read `process.cwd()` (`tests/controls.spec.tsx`, `tests/styles.spec.ts`) read relative to the spec file, so they pass from the repository root.
- Owner-admitting `connection: { admit: ... }` on the web server fake in `tests/fixtures/host.ts`, `tests/runtime.spec.ts` and `tests/model-surface.spec.ts`.
- API drift against dsh `0.2.2-rc.1`:
  - `src/app/http.ts`: the comment on the state response no longer cites `scripts/dsh-superagent`, which is not copied. `webServer.port` is `number | undefined`; an unbound port never matches a request origin.
  - `src/app/resources.ts`: `SessionController.inspect` no longer exists; the ticket transcript is read through `sessionPersistence.open(id, 'read')` pages. The fakes drop `inspect`; `tests/tools.spec.ts` feeds the transcript through the fixture's persistence reader.
  - `src/app/role-models.ts`: `agent/request` may no longer change the route (the loop rejects it) and `installModelSelection` takes only a context. The recorded `model/selection` event routes the first request; only the prompt variables are still overridden. `tests/role-models.spec.ts` asserts the recorded selection and the first-request route through `AgentModel.current()` over the real `modelSelectionProjectionDefinition`.
  - `tests/sources.spec.ts`: the malformed-line Feishu test uses the `late` fake CLI so the `ready` line cannot be processed after the event lines.
  - `src/client/deployment.tsx`: `ConfigFormSnapshot.mode` is gone; a snapshot with `writable: false` that is not loading is read-only.
- Test typing under the root aggregates: specs and fixtures that import `src/client` are `tests/*.client.spec.ts` (`draft`, `prompt-config`, `markdown`, `navigation`, `locales`) or `.tsx` (`tests/marks.spec.tsx`, `tests/fixtures/panel-server.tsx`, which the aggregates do not check); `<T>(` in `panel-server.tsx` is `<T,>(`. `tests/fixtures/deployment.ts` accepts `undefined` overrides. `exactOptionalPropertyTypes` and unused-name errors in `cards`, `runtime`, `sources`, `feishu-read`, `model-surface`, `store`, `fixtures/host.ts` and `fixtures/panel-server.tsx` are fixed in place (`as never` on fixture objects, unused names removed, `ConfigFormSnapshot.mode` dropped).
- `package.json` also lists the Cordis include, group and loader plugins as development dependencies, which `tests/bundle-patch.spec.ts` loads.
- Panel specs: `tests/fixtures/panel.tsx` and the nine `tests/panel-*.spec.tsx` import `./fixtures/panel-server.tsx` (renamed from `.ts`). `tests/panel-deployment.spec.tsx` no longer publishes `mode: 'memory'` in the read-only scenario (line 108); the snapshot has no `mode`, and `writable: false` selects the read-only hint.

Files outside the copy changed for S1:

- `tsconfig.base.json`: paths for `@mumbo/superagent`, `@mumbo/superagent/github-watch` and `@mumbo/superagent/feishu-watch`.
- `tsconfig.host.json` and `tsconfig.client.json`: a reference to each leaf of the package.
- `.oxlintrc.json` and `.oxlintrc.staged.json`: `ignorePatterns` entry for `packages/mumbo/superagent/**`.
- `package.json`: root `devDependencies` entry `@mumbo/superagent`, so a Host started from the repository resolves the plugin named in a `--patch` overlay. `apps/cli/package.json` is unchanged because the published CLI must not depend on a private package.
- `pnpm-lock.yaml`: the new workspace importer.
- `scripts/package-dependency-policy.ts`: `scopeParentOf` is classified peer-required for `@deepseek-ai/dsh-scope`; `src/app/sessions.ts` reads the scope chain, which is module state of the shared instance.

## S2: management API admission

`src/app/http.ts` admits management requests through the web server connection handle. Written by task A3.

## S3: delivery policy

`Policy.delivers(trigger)` in `src/core/ports.ts` decides whether a Trigger may reach a Ticket as an Input. Upstream delivers every Trigger on a subscribed Thread, whoever sent it.

- `src/policy.ts`: `settingsPolicy` delivers through `deliverable(settings, trigger)`. A person's Trigger is delivered only when `allowedSender` finds the sender on the Source's allowed list. A non-human Trigger is delivered only when `listedBot` finds it on the Source's bot list, or when it is GitHub CI: `source === 'github'`, an empty actor id and `meta.ci === true`, which `ciTrigger` (a PR's CI) and `branchCiTrigger` (default-branch CI) set. Every other senderless Trigger, such as a Feishu system, anonymous or id-less app message, is withheld and goes to Eval.
- `src/core/intake.ts`: subscription fan-out reaches no Ticket for a Trigger the Policy does not deliver. No Ticket decides that Trigger, so it is queued for Eval and resumes no ended Ticket.
- `src/core/tickets.ts`: `attachable` refuses such a Trigger with `notAdmissible`, reason `not_a_member` for a person and `not_human` for a bot. The `Engine.attach` `@throws` in `src/core/engine.ts` names this refusal.
- `src/executor/dsh.ts`: a delivered Trigger's `replies_to` preview, pushed to the worker, shows the message it answers only when `deliverable` would deliver that message.
- A merged pull request still ends the Tickets that follow it through PR polling, whoever merged it, so the merge bot needs no allowed-list entry.
- Prompts, each pinned in `tests/cards.spec.ts`:
  - `prompts/subscriptions.md` tells both roles that only an allowed person, a listed bot or CI reaches a Ticket, by subscription or by attach, and that an allowed sender's message resumes an ended Ticket.
  - `prompts/orchestrator.md` tells the main Session that messages on a subscribed thread from an allowlisted person, a listed bot or senderless CI go to the workers, and that an allowlisted person's message resumes an ended Ticket.
  - `prompts/dispatch.md` says CI, and review feedback from allowed senders and listed bots, reaches the worker directly.
- The bot-list hints of the GitHub and Feishu Sources (`src/sources/github.ts`, `src/sources/feishu.ts`) say a listed bot's messages on a subscribed thread also go straight to the tickets' Executors.
- `docs/001-domain.md` (fan-out "with no check of who sent it") and `docs/002-authorization.md` (every message on a subscribed Thread reaches its Tickets; resume "regardless of who sent it") are upstream prose this entry supersedes on who reaches a Ticket.
- Known limits:
  - `delivers` gates only what reaches a Ticket as an Input. A worker that reads a pull request or chat thread itself still sees the text of senders who are not on the allowed list. So does the `trigger/` resource it reads, whose `around` neighbours list every Trigger on a subscribed thread (`reached`).
  - `Tickets.wake` does not check `delivers` again. An Input that reached an ended Ticket before its sender left the allowed list can still resume that Ticket while its Mandate revalidates.
  - A GitHub sender is identified by login, which its owner can rename and someone else can later claim. An edited comment arrives as a new Trigger that keeps the original author's `user`, even when a collaborator or the agent account edited it. A later change should match on `user.id` and check the editor.
- Tests:
  - The Policy fake in `tests/assessment.spec.ts` delivers every Trigger. The fake in `tests/core-engine.spec.ts` does too, as a stand-in, and its S3 tests narrow it to `allowlisted`, the settings rule with `member` as the only allowed sender. Its two upstream tests that sent a guest's message to a Ticket (fan-out to a live Ticket, resume of an ended one) now send the member's.
  - `tests/sources.spec.ts` checks the settings rule on GitHub comments, on PR and default-branch CI (delivered), and on a senderless Trigger without `meta.ci` or from another Source (withheld). It also checks that Feishu history messages without a sender reach no subscribed Ticket, and that a polled merged PR ends its Ticket.
  - Upstream runtime tests whose follow-ups came from a sender off the allowed list now send them as the allowed member, or put the bot on the Feishu bot list (`tests/runtime-concurrency.spec.ts`), where the test is about something else. Where a test is about an outsider's message, it now expects no delivery: `tests/runtime.spec.ts` (no resume by a guest, a stranger's PR comment reaches no Ticket, CI with an empty actor id does) and `tests/followups.spec.ts` (a guest's message goes to Eval and the main Session cannot accept it, and the worker gets no preview of a guest's message a member answers).

## S4: person-only settings

Settings changes require a person principal. Written by task A5.

## S5: no merge, review marker

The worker does not merge and posts the review marker comment. Written by task A6.

## S6: project overlay

`deploy/mumbo-project.overlay.yml` is outside the copy and loads the package in project boxes. Written by task A7.
