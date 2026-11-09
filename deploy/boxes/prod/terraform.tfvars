e2b_sha         = "1619623fc"   # setup/build.sh output; nodes pick it up only when replaced (nodes.tf header)
edge_tag        = "26e8da5253"  # deploy/boxes/edge at this mumbo commit
node_count      = 2             # sandbox nodes; the edge cap MAX_RUNNING_UNITS = 2 * (12 * node_count - 2) follows (RUNBOOK: Adding nodes)
approver_emails = "hi@mumbo.si" # founder sign-in (2026-11-09)
ntfy_enabled    = true
