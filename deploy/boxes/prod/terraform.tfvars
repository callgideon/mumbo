e2b_sha  = "1619623fc"  # setup/build.sh output; nodes pick it up only when replaced (nodes.tf header)
edge_tag = "1b21c47c59" # deploy/boxes/edge at this mumbo commit
node_count = 2          # sandbox nodes; the edge cap MAX_RUNNING_BOXES = 12 * node_count - 2 follows (RUNBOOK: Adding nodes)
