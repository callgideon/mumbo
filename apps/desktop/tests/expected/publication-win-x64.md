
## Confirm before publishing

After checking the information below, click **Review deployments**, select <code>desktop-test</code>, and click **Approve and deploy**; if anything is wrong, click **Reject**.

| Item | Release information |
| --- | --- |
| Environment | <code>test</code> |
| Version | <code>1.0.0</code> |
| Update channel | <code>nightly</code> |
| Staged rollout percentage | Full (not set) |
| Platform | <code>win-x64</code> |
| Test release ID | <code>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</code><br>Random prefix of the test download path, used to make the address harder to guess; consecutive upgrade tests must use the same value. |
| Download URL preview | <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe">https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe</a><br>Target addresses after publishing; downloads are not guaranteed before approval. |
| Update YAML | <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml">https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml</a><br>This release will update this file; before approval it may not exist or may still point to the old version. |
| Package source | <a href="https&#58;//github.com/owner/repo/actions/runs/10/attempts/2">View packaging run #10 · attempt 2</a><br>Source: <code>master @ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</code><br>Packaging machine: <code>fixture-runner</code> |
| Signing and notarization | EXE signature verified |
| Git tag | Not created (test environment) |

### Runs after approval

1. Re-verify the artifacts and release target; stop if they differ from the approval digest.
2. Upload missing files and skip existing files with identical content; stop on a content conflict.
3. Update the update YAML above and save the release record.

**This release publishes to test only and does not modify production.**

<details>
<summary>Technical details and file list</summary>

COS bucket: <code>fixture-1250000000</code>

The release ID comes from the original package manifest. When packaging, the form field `test_release_id` takes precedence; if left empty, `DOWNLOAD_TEST_RELEASE_ID` from the machine `presets/test.env` is used. It is not re-selected at publish time.

Approval digest SHA-256: <code>cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc</code>

3 files in total; sizes and SHA-256 correspond to the bytes actually uploaded, including the updated YAML content.

| File | Size | SHA-256 |
| --- | --- | --- |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe">deepseek-harness-1.0.0-win-x64.exe</a> | 23 bytes | <code>7039e7b3e00d39fbfb2948ba31b6216ac9ffff01b4117a1cec08025255d9ad10</code> |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe.blockmap">deepseek-harness-1.0.0-win-x64.exe.blockmap</a> | 16 bytes | <code>4fd6c7d73e713d7f54f173dfc845d046d267f9e62c80a92670b0696131bfb74a</code> |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml">nightly.yml</a> | 272 bytes | <code>faccf50f8398d6781568114dda9a678751e4c01044dd9424d00237c69e58cb59</code> |

</details>

If the repository is public, the download paths in this summary and the release ID of a test release are also public. A random prefix is not a substitute for access authentication.
