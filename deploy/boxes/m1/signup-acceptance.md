# Open sign-up: acceptance checklist

This checklist runs the acceptance cases of §17a in `2026-11-09-mumbo-assistant-network-design.md` against production, plus two more: an unconfirmed email is refused, and a newcomer gets the capacity page when the cap is reached. The founder does the browser sign-ins and the Supabase and Google Workspace steps. The boxes session runs the AWS commands, and it alone changes the edge service (case 5). Run it after the sign-up changes are deployed (edge image, `MAX_RUNNING_BOXES`) and after the Supabase steps in `signup-supabase.md` are done. It takes about an hour, most of it waiting for backups.

## Before you start

Run the shell steps from the repository root with AWS credentials for account 641134885443.

```sh
export AWS_REGION=us-east-1
B=mumbo-boxes-backup-641134885443
h() { printf %s "$1" | tr '[:upper:]' '[:lower:]' | sha256sum | cut -d' ' -f1; }   # a person's backup folder: users/$(h <email>)/
logs() { aws logs filter-log-events --log-group-name /mumbo-boxes/edge --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern "\"$1\"" --query 'events[].message' --output text; }   # edge and oauth2-proxy lines naming <email>, last hour
TD=$(aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].taskDefinition' --output text)
```

Check each of these. If one fails, stop.

1. **Allowlist.** `aws ssm get-parameter --name /mumbo/boxes/allowed-emails --query Parameter.Value --output text` prints `@mumbo.si,@cambrialabs.ai`.
2. **oauth2-proxy checks `email_verified`.** `aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[?name=='oauth2-proxy'].[image,command,environment,secrets[].name]"` shows image `oauth2-proxy:v7.9.0`, `--provider=oidc` and `--scope=openid email`. No argument, variable or secret name contains `allow-unverified-email`, `ALLOW_UNVERIFIED_EMAIL`, `email-claim` or `EMAIL_CLAIM`. `node --test deploy/boxes/edge/config.test.mjs` passes (the test `no oauth2-proxy launch turns off its email_verified check` guards the repository copies).
3. **Edge cap.** `aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[?name=='edge'].environment[?name=='MAX_RUNNING_BOXES'].value"` prints 12 × nodes − 2.
4. **Supabase requires confirmation.** In the dashboard, under Authentication, then Sign In / Providers, then Email, "Confirm email" is on. With it off, Supabase marks every new email as verified without a click. oauth2-proxy then cannot tell, and case 3 fails.
5. **Fresh test accounts.** Each account in the table has no Supabase user (Authentication, then Users, then search) and no backups (`aws s3 ls s3://$B/users/$(h <email>)/` prints nothing).

| Case | Account | Sign-in |
|---|---|---|
| 1 | A new Google Workspace user at `@cambrialabs.ai` (for example `signup-test@cambrialabs.ai`); the founder creates it in the Google Admin console | Continue with Google |
| 2 | `hi+signup-link@mumbo.si` | Email me a sign-in link |
| 3 | `hi+signup-unconfirmed@mumbo.si` | Email link, never clicked |
| 4 | Any personal `@gmail.com` Google account | Continue with Google |
| 5 | `hi+signup-cap@mumbo.si` | Email link |

The `hi+…@mumbo.si` addresses are separate accounts and boxes for Supabase and the edge, and none of them is an approver (`APPROVER_EMAILS` matches `hi@mumbo.si` exactly). If mumbo.si mail does not deliver plus addresses to `hi@mumbo.si`, create aliases instead. Use a new private browser window for each case, and close it when the case ends.

## 1. A new `@cambrialabs.ai` account signs in with Google

1. Open `https://boxes.mumbo.si/`. You see the Supabase sign-in page, with "Continue with Google" and "Email me a sign-in link" and no password field.
2. Choose Continue with Google and pick the case 1 account.
3. You see "Setting up your computer, about a minute". The page reloads itself, and within about two minutes the assistant opens.
4. The assistant greets you once. The greeting says what it can do now, says that connecting accounts and projects comes later, and links `https://boxes.mumbo.si/home`. Open the link. The home page says "Signed in as" with the case 1 email.
5. Start a second chat. It has no greeting.
6. Box state: `logs <email>` shows exactly one `{"edge":"box","msg":"created","user":"<email>",…}` line. After 10 to 12 minutes, `aws s3 ls s3://$B/users/$(h <email>)/` lists `latest.tar.gz`.

## 2. A new `@mumbo.si` account signs in by email link

1. Open `https://boxes.mumbo.si/`, choose "Email me a sign-in link" and enter `hi+signup-link@mumbo.si`. The page says a link was sent.
2. Open the link from the email in the same private window; copy it from the mail client if needed.
3. Check steps 3 to 6 of case 1, with this email.

## 3. An email that never clicked its confirmation link is refused

Two layers refuse an unconfirmed email. Supabase issues no session for one, because "Confirm email" is on. oauth2-proxy refuses an ID token whose `email_verified` is `false`. The edge never sees the token, so it cannot check the claim itself.

1. Open `https://boxes.mumbo.si/`, ask for a sign-in link for `hi+signup-unconfirmed@mumbo.si`, and do not open the email.
2. Open `https://boxes.mumbo.si/` again. You are back on the sign-in page. In Supabase, under Authentication, then Users, the account waits for verification and has no confirmed time. `logs hi+signup-unconfirmed@mumbo.si` prints nothing.
3. Check that a password sign-up gives no session either. This is the path someone would use to claim another person's address. `ANON` is the project's public anon key, from the Supabase dashboard under Project Settings, then API. It is public, but keep it out of chat transcripts.

   ```sh
   SB=https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1; E=hi+signup-unconfirmed@mumbo.si; PW=$(openssl rand -base64 24)
   curl -s "$SB/signup" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$PW\"}" | jq '{session: has("access_token")}'
   curl -s "$SB/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"$PW\"}" | jq '{session: has("access_token"), error_code}'
   ```

   Pass: both print `"session": false`, and the second prints `"error_code": "email_not_confirmed"`. If sign-up is refused outright, that is also a pass. Fail: either one prints `"session": true`, which means Supabase confirms emails by itself. Turn "Confirm email" on, then delete this user and every user created since it was off.
4. Check the oauth2-proxy layer by configuration, because Supabase issues no token for an unconfirmed email. Rely on steps 2 and 4 of "Before you start" and on these facts, rechecked whenever the oauth2-proxy image changes:
   - oauth2-proxy v7.9.0 refuses an ID token whose `email_verified` claim is `false` (`providers/provider_data.go`, `buildSessionFromClaims`). It accepts a token without the claim. It skips the check under `--insecure-oidc-allow-unverified-email` or a changed `--oidc-email-claim`.
   - Supabase's ID token always carries `email_verified`, true only when the email is confirmed, once the `email` scope is granted (supabase/auth `internal/tokens/service.go`, `IDTokenClaims`). `--scope=openid email` grants that scope.
   - When oauth2-proxy refuses, the browser gets oauth2-proxy's 500 error page, and the edge log group gets `Error redeeming code during OAuth2 callback: email in id_token (<email>) isn't verified` in an `oauth2-proxy/…` stream.

## 4. A `gmail.com` account gets the invite-only page

1. Open `https://boxes.mumbo.si/` and choose Continue with Google with the personal Gmail account.
2. You see the invite-only page (HTTP 403). It says mumbo is invite-only and names `@mumbo.si` and `@cambrialabs.ai` as the domains that can join. It does not reload.
3. `logs <gmail address>` shows oauth2-proxy's `[AuthSuccess]` line but no edge `created` line, and `aws s3 ls s3://$B/users/$(h <gmail address>)/` prints nothing. Supabase does create an account for this address. The cleanup deletes it.

## 5. With the cap reached, the next newcomer gets the capacity page

The cap counts every running E2B sandbox: person boxes, project boxes and child sandboxes. Only creating a box checks it, so existing boxes keep working. The boxes session lowers the cap to 1 by moving the edge service to a copy of its task definition, then moves it back. Keep the window short: while the cap is lowered, no new person or project box can be created and no box can be recreated from a backup.

```sh
DIR=$(mktemp -d)
aws ecs describe-task-definition --task-definition "$TD" --query taskDefinition | jq '{family, taskRoleArn, executionRoleArn, networkMode, requiresCompatibilities, cpu, memory, runtimePlatform, volumes, placementConstraints,
  containerDefinitions: [.containerDefinitions[] | if .name == "edge" then .environment = ([.environment[] | select(.name != "MAX_RUNNING_BOXES")] + [{name: "MAX_RUNNING_BOXES", value: "1"}]) else . end]}' > "$DIR/cap.json"
CAP=$(aws ecs register-task-definition --cli-input-json "file://$DIR/cap.json" --query taskDefinition.taskDefinitionArn --output text)
aws ecs update-service --cluster mumbo-boxes-e2b --service edge --task-definition "$CAP" --query service.taskDefinition
aws ecs wait services-stable --cluster mumbo-boxes-e2b --services edge
```

1. Sign in as `hi+signup-cap@mumbo.si` by email link.
2. You see "mumbo is at capacity right now. This page retries every few seconds." (HTTP 503), and the page reloads itself. `logs hi+signup-cap@mumbo.si` shows `{"edge":"error","user":"hi+signup-cap@mumbo.si",…,"error":"capacity"}` and no `created` line.
3. The founder's own box still opens at `https://boxes.mumbo.si/`.
4. Restore the service, and leave the case 5 window open:

   ```sh
   aws ecs update-service --cluster mumbo-boxes-e2b --service edge --task-definition "$TD" --query service.taskDefinition
   aws ecs wait services-stable --cluster mumbo-boxes-e2b --services edge
   aws ecs deregister-task-definition --task-definition "$CAP" --query taskDefinition.status
   rm -r "$DIR"
   terraform -chdir=deploy/boxes/prod plan   # expect no change to aws_ecs_service.edge
   ```

5. Within a few seconds the case 5 page moves on to "Setting up your computer, about a minute", and the box is created.

## Cleanup

Delete every test account in this order:

1. Close every test window. An open session could otherwise create a new box on its next request: oauth2-proxy keeps a session until the Supabase access token expires, which takes 1 hour by default.
2. Delete each account's box and backups with the runbook procedure "Offboarding a person" (`deploy/boxes/RUNBOOK.md`). After that, `aws s3 ls s3://$B/users/$(h <email>)/` prints nothing, and `logs <email>` shows no box activity after the deletion.
3. The founder deletes the Supabase users for cases 1 to 5 (Authentication, then Users, then the row's menu, then Delete user) and suspends or deletes the case 1 Workspace user in the Google Admin console.

## Record

| Case | Date | Pass | Notes |
|---|---|---|---|
| 1 Google, `@cambrialabs.ai` | | | |
| 2 Email link, `@mumbo.si` | | | |
| 3 Unconfirmed email refused | | | |
| 4 `gmail.com` invite-only | | | |
| 5 Cap reached | | | |
| Cleanup | | | |
