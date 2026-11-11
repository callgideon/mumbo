---
kind: upgrade-guide
description: "The `@mumbo/browser-consent` row now requires `uploadDirectory`, `uploadStaging`, and `browser.outputDir`, and uploads send only staged copies of files named directly in the upload directory."
---

# `@mumbo/browser-consent` requires upload settings and stages every upload

## Change

In v0.2.2-rc.1 the [`@mumbo/browser-consent`](../../../../packages/mumbo/browser-consent/README.md#configuration) row had no upload settings, `browser.outputDir` was optional, and `browser_file_upload` and `browser_drop` sent any path the Playwright MCP server could read once the person approved it. Now:

- `uploadDirectory` is required: an absolute directory, such as `/home/shared/Downloads`, named by its real path below directories that only root and dsh's own user can change. Only files named directly in it are sent.
- `uploadStaging` is required: an absolute directory, such as `/var/lib/mumbo/uploads`, named by its real path, owned by root or dsh's own user, and writable by no other user. It must not be, contain, or lie inside `uploadDirectory` or `browser.outputDir`. The plugin copies each file there and the browser receives the copy; at load the plugin deletes the entries named with 32 lowercase hex characters, its copies' directories, and leaves the rest.
- `browser.outputDir` is required, and the plugin sets the provider's file root to `uploadStaging` itself.
- `uploadMaxBytes`, 512 MiB by default, caps each file.
- The approval question adds `Files sent: "<name>" (<size> bytes, SHA-256 <first 12 hex>)`. A path not directly in the upload directory is refused before any question with `Error: <tool> did not run: <path> is not directly in <uploadDirectory>; put the file directly in <uploadDirectory> and retry.`, and the [refusals](../../../../packages/mumbo/browser-consent/README.md#model-experience) list why a file there can be refused.

A row without the new keys fails plugin load, and its browser tools disappear; computer use, whose row injects the consent service, does not load either. Affected: deployments that compose `@mumbo/browser-consent`, such as a person box's overlay.

## Migration

1. Create a system group that holds only the users the browser and its MCP server run as, then the staging directory, set-group-ID in that group, below a root-owned `0755` parent:

   ```sh
   groupadd -r uploads
   usermod -aG uploads <browser user>
   usermod -aG uploads <browser MCP server user>
   install -d -o root -g uploads -m 2750 /var/lib/mumbo/uploads
   ```

   A browser server under `browser.identity` gets exactly its subprocess identity's `groups`, so add the group's gid (`getent group uploads`) there; otherwise it cannot read the `0440` copies and every approved upload fails.

2. Add the keys to the `browser-consent` row's `config`:

   ```yaml
   browser:
     # the existing provider settings, plus:
     outputDir: /var/lib/mumbo/playwright-output
   uploadDirectory: /home/shared/Downloads
   uploadStaging: /var/lib/mumbo/uploads
   ```

   `outputDir` names a directory the browser server's user owns in a root-owned parent.
3. Tell the people who upload that a file must sit directly in `uploadDirectory`, not in a subfolder, and be readable by the model's run-as user.
4. Confirm the migration: start the deployment, check the log has no `mumbo-browser-consent` load error, and ask the assistant to upload a file from a subfolder of the upload directory; the tool answers that the file is not directly in the upload directory.
