#!/bin/bash
# tunnel.sh up|down — SSM port forwards to the internal NLB through a sandbox node (api :13000, client-proxy :13002),
# with a temporary NLB rule admitting the node on :3002. Stage 5/8 testing only.
S=${TUNNEL_STATE:-${TMPDIR:-/tmp}/mumbo-tunnel}; mkdir -p "$S"
NLB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=mumbo-boxes-internal-nlb --query 'SecurityGroups[0].GroupId' --output text)
if [ "$1" = down ]; then
  ps -eo pid,args | awk '/StartPortForwardingSessionToRemoteHost/ && !/awk/ {print $1}' | xargs -r kill
  [ -s $S/temp-sg-rule ] && aws ec2 revoke-security-group-ingress --group-id $NLB_SG --security-group-rule-ids $(cat $S/temp-sg-rule) >/dev/null; : > $S/temp-sg-rule
  exit 0
fi
NODE=${NODE:-$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`]|[0].InstanceId' --output text)}
NODE_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=mumbo-boxes-nodes --query 'SecurityGroups[0].GroupId' --output text)
[ -s $S/temp-sg-rule ] || aws ec2 authorize-security-group-ingress --group-id $NLB_SG --ip-permissions "IpProtocol=tcp,FromPort=3002,ToPort=3002,UserIdGroupPairs=[{GroupId=$NODE_SG,Description=TEMP-tunnel}]" --query 'SecurityGroupRules[0].SecurityGroupRuleId' --output text > $S/temp-sg-rule
for p in 3000:13000 3002:13002; do
  nohup aws ssm start-session --target $NODE --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=sandbox.boxes.internal,portNumber=${p%%:*},localPortNumber=${p##*:}" > $S/tunnel-${p%%:*}.log 2>&1 &
done
sleep 8; echo "tunnels via $NODE: api $(curl -s -m 5 -o /dev/null -w %{http_code} localhost:13000/health) proxy $(curl -s -m 5 -o /dev/null -w %{http_code} localhost:13002/)"
