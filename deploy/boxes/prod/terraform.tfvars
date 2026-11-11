e2b_sha         = "1619623fc"   # setup/build.sh output; nodes pick it up only when replaced (nodes.tf header)
edge_tag        = "c1280ab974"  # deploy/boxes/edge at this mumbo commit
node_count      = 2             # sandbox nodes; the edge cap MAX_RUNNING_UNITS = 2 * (12 * node_count - 2) follows (RUNBOOK: Adding nodes)
approver_emails = "hi@mumbo.si" # founder sign-in (2026-11-09)
ops_alert_email = "hi@mumbo.si" # alarms and edge-deploy-failed by email (the founder); confirm the AWS email once
ntfy_enabled    = true
# The agent is the mumbo-bot App's bot user (design section 9); id from GET /users/mumbo-bot%5Bbot%5D (2026-11-09).
github_agent_login = "mumbo-bot[bot]"
github_agent_id    = "341797844"
