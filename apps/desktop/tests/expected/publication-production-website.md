
## Confirm before publishing

After checking the information below, click **Review deployments**, select <code>desktop-production</code>, and click **Approve and deploy**; if anything is wrong, click **Reject**.

| Item | Release information |
| --- | --- |
| Environment | <code>production</code> |
| Version | <code>1.0.0</code> |
| Update channel | <code>stable</code> |
| Staged rollout percentage | Full (not set) |
| Platform | <code>win-x64</code> |
| Download URL preview | <a href="https&#58;//download.example.com/dsh-desk/bin/win-x64/stable/deepseek-harness-1.0.0-win-x64.exe">https&#58;//download.example.com/dsh-desk/bin/win-x64/stable/deepseek-harness-1.0.0-win-x64.exe</a><br>Target addresses after publishing; downloads are not guaranteed before approval. |
| Update YAML | <a href="https&#58;//download.example.com/dsh-desk/feeds/win-x64/stable.yml">https&#58;//download.example.com/dsh-desk/feeds/win-x64/stable.yml</a><br>This release will update this file; before approval it may not exist or may still point to the old version. |
| Package source | <a href="https&#58;//github.com/owner/repo/actions/runs/20/attempts/3">View packaging run #20 · attempt 3</a><br>Source: <code>dsh-v1.0.0 @ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</code><br>Packaging machine: <code>windows-publisher</code> |
| Signing and notarization | EXE signature verified |
| Pinned website installer | <a href="https&#58;//download.deepseek.com/desktop/dsh-latest-windows-x64.exe">https&#58;//download.deepseek.com/desktop/dsh-latest-windows-x64.exe</a><br>Replaced with version <code>1.0.0</code>; the existing installer will be replaced, with no downgrade protection; the website upload and refresh run in a later job and may need separate approval. |
| Git tag | <code>desktop-v1.0.0</code> |

### Runs after approval

1. Re-verify the artifacts and release target; stop if they differ from the approval digest.
2. Upload missing files and skip existing files with identical content; stop on a content conflict.
3. Update the update YAML above and save the release record.
4. Create the Git tag above for the commit that was actually packaged; if tag creation fails, record "published, tag pending".

<details>
<summary>Technical details and file list</summary>

COS bucket: <code>production-1234567890</code>

Approval digest SHA-256: <code>cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc</code>

2 files in total; sizes and SHA-256 correspond to the bytes actually uploaded, including the updated YAML content.

| File | Size | SHA-256 |
| --- | --- | --- |
| <a href="https&#58;//download.example.com/dsh-desk/bin/win-x64/stable/deepseek-harness-1.0.0-win-x64.exe">deepseek-harness-1.0.0-win-x64.exe</a> | 15 bytes | <code>e34210a6de4f653edf588301431c3d69a633638cbf587345cc50a7fed9f38f4c</code> |
| <a href="https&#58;//download.example.com/dsh-desk/feeds/win-x64/stable.yml">stable.yml</a> | 15 bytes | <code>8850e6075dda0080c526269a4de29848c32c2a65e3d81f4a64ed8ce53d4b47c1</code> |

</details>

If the repository is public, the download paths in this summary and the release ID of a test release are also public. A random prefix is not a substitute for access authentication.
