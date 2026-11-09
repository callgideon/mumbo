# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate the note, insert an `Archived: YYYY-MM-DD` line below its `Status: implemented` line, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, unknown kind folders, and invalid archive metadata.

The English-only archive replacement removed every archived Chinese translation, consistency record, and language-switcher line, translated Chinese text inside archived English notes, and deleted three translation-process notes. `scripts/archived-agent-notes.ts` accepts exactly that replacement, and only against a baseline manifest that still seals a `.zh.md` or `.i18n.yaml` file. Once the baseline seals only English notes, every seal is append-only again; this exception permits no other content change, reversal, or deletion.
