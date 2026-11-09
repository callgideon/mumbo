# Open sign-up: acceptance checklist

This checklist runs the five acceptance cases of §17a in `2026-11-09-mumbo-assistant-network-design.md` against production. The founder does the browser sign-ins and the Supabase and Google Workspace steps. The boxes session runs the AWS commands, and it alone changes the edge service (case 5).

Run it only when all of these are true:
- every sign-up change has landed and is deployed, including S5's capacity units and the runbook section "Offboarding a person" in `deploy/boxes/RUNBOOK.md`;
- the Supabase steps in `signup-supabase.md` are done.

It takes about an hour, most of it waiting for backups.

## Before you start

Run the shell steps from the repository root with AWS credentials for account 641134885443.

```sh
export AWS_REGION=us-east-1
B=mumbo-boxes-backup-641134885443
RUN=$(date +%m%d%H%M)   # makes this run's test addresses new
TD=$(aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].taskDefinition' --output text)
envv() { aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[?name=='edge'] | [0].environment[?name=='$1'] | [0].value" --output text; }
HOST=$(envv PUBLIC_HOST); APPROVE=$(envv APPROVE_HOST); echo "$HOST $APPROVE"
h() { printf %s "$1" | tr '[:upper:]' '[:lower:]' | sha256sum | cut -d' ' -f1; }   # a person's backup folder: users/$(h <email>)/
logs() { aws logs filter-log-events --log-group-name /mumbo-boxes/edge --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern "\"$1\"" --query 'events[].[timestamp,message]' --output json | jq -r '.[] | "\(.[0] / 1000 | floor | todate) \(.[1])"'; }   # edge and oauth2-proxy lines naming <email>, last hour, with UTC times
```

Check each of these. If one fails, stop.

1. **Signing in reaches the sign-in page, without a loop.**
   - `curl -sS -L --max-redirs 6 -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}\n' "https://$HOST/"` must print `200`, at most 6 redirects, and a URL that starts with `https://$APPROVE/oauth/consent?authorization_id=`. curl error 47 ("Maximum (6) redirects followed") means a loop.
   - `curl -sS -L --max-redirs 6 "https://$HOST/" | grep -c -e 'Continue with Google' -e 'Email me a sign-in link'` must print `2`. The same command with `grep -ci password` must print `0`.
2. **Allowlist.** `aws ssm get-parameter --name /mumbo/boxes/allowed-emails --query Parameter.Value --output text` prints `@mumbo.si,@cambrialabs.ai`, plus any `!<address>` deny entries from earlier offboarding.
3. **oauth2-proxy checks `email_verified`.**
   - `aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[?name=='oauth2-proxy'] | [0].[image,command]"` shows image `oauth2-proxy:v7.9.0`, `--provider=oidc` and `--scope=openid email`.
   - `aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[?name=='oauth2-proxy']" --output json | grep -i -E 'unverified|email[-_]?claim|user[-_]?id[-_]?claim'` prints nothing. It checks the command, the variables and the secret names together.
   - `node --test deploy/boxes/edge/config.test.mjs` passes. Its test `no oauth2-proxy launch turns off its email_verified check` scans every `deploy/boxes/prod/*.tf`, `terraform.tfvars`, `compose.yaml` and `up.sh`.
4. **Edge cap.**
   - `N=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes --query 'AutoScalingGroups[0].DesiredCapacity' --output text); echo "$(envv MAX_RUNNING_UNITS) $(( 2 * (12 * N - 2) ))"` prints the same number twice.
   - `N` is also `node_count` in `deploy/boxes/prod/terraform.tfvars`.
   - A box costs 2 units and a child sandbox costs 1.
5. **Supabase.** In the dashboard, under Authentication:
   - **Sign In / Providers, then Email:** "Confirm email" is on. With it off, Supabase marks every new email as verified without a click. oauth2-proxy then cannot tell, and case 3 fails.
   - **URL Configuration, Redirect URLs:** the list includes `https://$APPROVE/oauth/consent*`. Without it, Google and email-link sign-ins fail.
   - **Rate Limits:** the email limit allows the 4 emails this checklist sends (cases 2, 3, the case 3 probe, and 5). If it does not, wait out the window between those cases.
6. **Fresh test accounts.** Each account below has no Supabase user. Check under Authentication, then Users, by searching for it. The `$RUN` suffix keeps the `@mumbo.si` addresses new on every run.

| Case | Account | Sign-in |
|---|---|---|
| 1 | A new Google Workspace user at `@cambrialabs.ai` (for example `signup-test-<RUN>@cambrialabs.ai`); the founder creates it in the Google Admin console | Continue with Google |
| 2 | `hi+link-$RUN@mumbo.si` | Email me a sign-in link, then open the link |
| 3 | `hi+unconfirmed-$RUN@mumbo.si`, then `hi+probe-$RUN@mumbo.si` for the probe | Email link, never opened |
| 4 | Any personal `@gmail.com` Google account | Continue with Google |
| 5 | `hi+cap-$RUN@mumbo.si` | Email me a sign-in link, then enter the code |

The `hi+…@mumbo.si` addresses are separate accounts and boxes for Supabase and the edge. None of them is an approver, because `APPROVER_EMAILS` matches `hi@mumbo.si` exactly. If mumbo.si mail does not deliver plus addresses to `hi@mumbo.si`, create aliases instead. `echo hi+link-$RUN@mumbo.si` prints an address to type. Use a new private browser window for each case.

## 1. A new `@cambrialabs.ai` account signs in with Google

1. Open `https://$HOST/`. The mumbo sign-in page opens on `$APPROVE`:
   - the title "Welcome to mumbo";
   - a "Continue with Google" button;
   - an email field with an "Email me a sign-in link" button;
   - the footer "New here? Signing in creates your account.";
   - no password field.
2. Choose Continue with Google and pick the case 1 account.
3. You see "Setting up your computer, about a minute". The page reloads itself, and within about two minutes the assistant opens.
4. Send a first prompt, such as `hi`. The reply carries the welcome:
   - what the assistant can do now;
   - that connecting accounts and projects comes later;
   - a link to `https://$HOST/home`.

   Open the link. The home page says "Signed in as" with the case 1 email.
5. Start a new chat and send another prompt. Its reply has no welcome.
6. Check the box state. `logs <email>` shows exactly one `{"edge":"box","msg":"created","user":"<email>",…}` line. After 10 to 12 minutes, `aws s3 ls s3://$B/users/$(h <email>)/` lists `latest.tar.gz`.

## 2. A new `@mumbo.si` account signs in by email link

1. Open `https://$HOST/`, enter `hi+link-$RUN@mumbo.si` and choose "Email me a sign-in link". The page changes to "Check your email": "Open the sign-in link sent to hi+link-…, or enter its code here."
2. Open the link from the email in the same private window. Copy it out of the mail client if needed.
3. Check steps 3 to 6 of case 1, with this email.

## 3. An email that never clicked its confirmation link is refused

Two layers refuse an unconfirmed email:
- Supabase issues no session for one, because "Confirm email" is on.
- oauth2-proxy refuses an ID token whose `email_verified` is `false`.

The edge never sees the token, so it cannot check the claim itself.

1. Open `https://$HOST/`, ask for a sign-in link for `hi+unconfirmed-$RUN@mumbo.si`, and neither open the link nor enter the code.
2. Open `https://$HOST/` again. You are back on the sign-in page. In Supabase, under Authentication, then Users, the account waits for verification and has no confirmed time. `logs hi+unconfirmed-$RUN@mumbo.si` prints nothing.
3. Check that a password sign-up gives no session either. This is the path someone would use to claim another person's address.

   The probe needs an address Supabase has never seen. Do not reuse the step 1 address, which Supabase already holds. With "Confirm email" off, that user would already be confirmed with an unknown password, so the probe would print `invalid_credentials` and pass when it should fail.

   `ANON` is the project's public anon key, from the Supabase dashboard under Project Settings, then API. It is public, but keep it out of chat transcripts.

   ```sh
   SB=https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1; E=hi+probe-$RUN@mumbo.si; PW=$(openssl rand -base64 24)
   curl -s "$SB/signup" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$PW\"}" | jq '{session: has("access_token"), error_code}'
   curl -s "$SB/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$PW\"}" | jq '{session: has("access_token"), error_code}'
   ```

   - **Pass:** the first command prints `"session": false, "error_code": null`, which means the user was created and a confirmation email sent. The second prints `"session": false, "error_code": "email_not_confirmed"`.
   - **Fail:** either command prints `"session": true`, which means Supabase confirms emails by itself. Turn "Confirm email" on, then delete this user and every user created since it was off.
   - **No result:** the first command prints an error such as `over_email_send_rate_limit`. Supabase created no user, so the second then prints `invalid_credentials`, and the run proves nothing. Wait until the email rate-limit window has passed, set `RUN=$(date +%m%d%H%M)`, and repeat with the new `E`.
4. Check the oauth2-proxy layer by configuration, because Supabase issues no token for an unconfirmed email. Rely on checks 3 and 5 of "Before you start" and on these facts:
   - oauth2-proxy v7.9.0 refuses an ID token whose `email_verified` claim is `false` (`providers/provider_data.go`, `buildSessionFromClaims`). It accepts a token that lacks the claim.
   - It skips the check under `--insecure-oidc-allow-unverified-email`. It also skips it when `--oidc-email-claim` or its deprecated alias `--user-id-claim` names a claim other than `email` (`providers/providers.go`).
   - Supabase's ID token always carries `email_verified` once the `email` scope is granted (supabase/auth `internal/tokens/service.go`, `IDTokenClaims`). It is true only when the email is confirmed. `--scope=openid email` grants the scope.
   - When oauth2-proxy refuses, the browser gets oauth2-proxy's 500 error page. An `oauth2-proxy/…` stream in the edge log group gets `Error redeeming code during OAuth2 callback: email in id_token (<email>) isn't verified`.
   - The protection depends on Supabase always sending the claim. Recheck these facts whenever the oauth2-proxy image changes, and whenever Supabase Auth changes: its release notes, or `claims_supported` in `https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1/.well-known/openid-configuration` no longer listing `email_verified`.

## 4. A `gmail.com` account gets the invite-only page

1. Open `https://$HOST/` and choose Continue with Google with the personal Gmail account.
2. You see the invite-only page (HTTP 403). It says mumbo is invite-only and names `@mumbo.si` and `@cambrialabs.ai` as the domains that can join. It does not reload.
3. `logs <gmail address>` shows oauth2-proxy's `[AuthSuccess]` line but no edge `created` line, and `aws s3 ls s3://$B/users/$(h <gmail address>)/` prints nothing. Supabase does create an account for this address. The cleanup deletes it.

## 5. With the cap reached, the next newcomer gets the capacity page

The cap counts the capacity units of every running E2B sandbox: person and project boxes cost 2 units each, and children 1. Only creating a sandbox checks it, so existing boxes keep working.

The boxes session sets `MAX_RUNNING_UNITS` to 1, which refuses any new box. It does this by moving the edge service to a copy of Terraform's task definition in a separate family, `mumbo-boxes-edge-capcheck`. Terraform's family `mumbo-boxes-edge` is never touched, so the restore needs no saved variable. Keep the window short. While the cap is lowered, nobody can create a person box, project box or child sandbox, and no box can be recreated from a backup.

First confirm the service runs Terraform's latest revision: `aws ecs describe-task-definition --task-definition mumbo-boxes-edge --query taskDefinition.taskDefinitionArn --output text` must equal `$TD`. If it does not, a deployment is in progress or the service has drifted, so stop. Then lower the cap:

```sh
DIR=$(mktemp -d)
aws ecs describe-task-definition --task-definition mumbo-boxes-edge --query taskDefinition | jq '{family: "mumbo-boxes-edge-capcheck", taskRoleArn, executionRoleArn, networkMode, requiresCompatibilities, cpu, memory, runtimePlatform, volumes, placementConstraints,
  containerDefinitions: [.containerDefinitions[] | if .name == "edge" then .environment = ([.environment[] | select(.name != "MAX_RUNNING_UNITS")] + [{name: "MAX_RUNNING_UNITS", value: "1"}]) else . end]}' > "$DIR/cap.json"
aws ecs register-task-definition --cli-input-json "file://$DIR/cap.json" --query taskDefinition.taskDefinitionArn --output text
rm -r "$DIR"
aws ecs update-service --cluster mumbo-boxes-e2b --service edge --task-definition mumbo-boxes-edge-capcheck --query service.taskDefinition
aws ecs wait services-stable --cluster mumbo-boxes-e2b --services edge
```

1. Open `https://$HOST/`, enter `hi+cap-$RUN@mumbo.si` and choose "Email me a sign-in link". Then type the code from the email into the code field and choose "Verify and continue". Do not open the link: this case covers the code path.
2. You see "mumbo is at capacity right now. This page retries every few seconds." (HTTP 503), and the page reloads itself. `logs hi+cap-$RUN@mumbo.si` shows `{"edge":"error","user":"hi+cap-…","error":"capacity"}` and no `created` line.
3. The founder's own box still opens at `https://$HOST/`.
4. Restore the cap, and leave the case 5 window open. These commands read everything from AWS, so they work from any shell at any later time:

   ```sh
   aws ecs update-service --cluster mumbo-boxes-e2b --service edge --task-definition mumbo-boxes-edge --query service.taskDefinition   # the latest revision of Terraform's family
   aws ecs wait services-stable --cluster mumbo-boxes-e2b --services edge
   aws ecs describe-task-definition --task-definition mumbo-boxes-edge --query "taskDefinition.containerDefinitions[?name=='edge'] | [0].environment[?name=='MAX_RUNNING_UNITS'] | [0].value"   # 2 * (12 * N - 2) again
   for t in $(aws ecs list-task-definitions --family-prefix mumbo-boxes-edge-capcheck --query taskDefinitionArns --output text); do aws ecs deregister-task-definition --task-definition "$t" --query taskDefinition.status; done
   terraform -chdir=deploy/boxes/prod plan   # expect no change to aws_ecs_service.edge
   ```

   **Recovery.** A failure can come from either side:
   - The capped deployment fails and the circuit breaker rolls it back.
   - The restore's wait times out.

   Check where the service stands with `aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].deployments[].[status,taskDefinition,rolloutState]'`, then run the restore block again. If the service is still not on `mumbo-boxes-edge`, the boxes session reviews `terraform -chdir=deploy/boxes/prod plan` and applies it. That puts `aws_ecs_service.edge` back on Terraform's task definition.
5. Within a few seconds the case 5 page moves on to "Setting up your computer, about a minute", and the box is created.

## Cleanup

With the deployed flags, an oauth2-proxy session lasts 168 hours: neither `--cookie-refresh` nor `--cookie-expire` is set. v7.9.0 never rechecks a session against Supabase in that time. Deleting or banning the Supabase user, or suspending the Workspace user, only stops new sign-ins. The edge deny entry is what ends a live session. Follow "Offboarding a person" in `deploy/boxes/RUNBOOK.md` in this order:

1. Close every test window.
2. The founder suspends the case 1 Workspace user (runbook step 1). The founder then deletes the Supabase users for cases 1, 2 and 4, both case 3 addresses, and case 5 (runbook step 2).
3. The boxes session adds deny entries for the addresses that got a session and a box: cases 1, 2 and 5. It does this with one parameter update and one forced edge deployment (runbook step 3). The deny entries stay, because later runs use new `$RUN` addresses.
4. The boxes session runs `node offboard.mjs <email>` as a dry run, then `node offboard.mjs <email> --delete <email>`, for cases 1, 2 and 5 (runbook step 4). Afterwards, `aws s3 ls s3://$B/users/$(h <email>)/` prints nothing.

## Record

| Case | Date | Pass | Notes |
|---|---|---|---|
| Before you start | | | |
| 1 Google, `@cambrialabs.ai` | | | |
| 2 Email link, `@mumbo.si` | | | |
| 3 Unconfirmed email refused | | | |
| 4 `gmail.com` invite-only | | | |
| 5 Cap reached | | | |
| Cleanup | | | |
