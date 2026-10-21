#!/bin/bash
# Moves app.mumbo.si / api.mumbo.si from the jumbo-gateway CloudFront distribution to the Mumbo prod stack.
# Prereq: mumbo-prod deployed and verified via origin-prod.mumbo.si. Backups are written to $BK for rollback.
set -euo pipefail
PROFILE=gideon; ZONE=Z07707413UYOQHO5GVGN4; DIST=EIJ5MN37DK873
BK=${BK:-$(mktemp -d)}; echo "backups: $BK"

# 1. Remove the aliases and certificate from the jumbo distribution.
aws cloudfront get-distribution-config --id $DIST --profile $PROFILE > "$BK/dist.json"
python3 - "$BK" <<'PY'
import json, sys
c = json.load(open(f'{sys.argv[1]}/dist.json'))['DistributionConfig']
c['Aliases'] = {'Quantity': 0}
c['ViewerCertificate'] = {'CloudFrontDefaultCertificate': True, 'MinimumProtocolVersion': 'TLSv1', 'CertificateSource': 'cloudfront'}
json.dump(c, open(f'{sys.argv[1]}/dist-new.json', 'w'))
PY
aws cloudfront update-distribution --id $DIST --if-match "$(python3 -c "import json;print(json.load(open('$BK/dist.json'))['ETag'])")" \
  --distribution-config "file://$BK/dist-new.json" --profile $PROFILE --query 'Distribution.Status' --output text
aws cloudfront wait distribution-deployed --id $DIST --profile $PROFILE

# 2. Delete the A/AAAA alias records for app and api (exact current values, so the delete matches).
aws route53 list-resource-record-sets --hosted-zone-id $ZONE --profile $PROFILE > "$BK/records.json"
python3 - "$BK" <<'PY'
import json, sys
rs = json.load(open(f'{sys.argv[1]}/records.json'))['ResourceRecordSets']
ch = [{'Action': 'DELETE', 'ResourceRecordSet': r} for r in rs if r['Name'] in ('app.mumbo.si.', 'api.mumbo.si.') and r['Type'] in ('A', 'AAAA')]
json.dump({'Changes': ch}, open(f'{sys.argv[1]}/delete.json', 'w'))
print(len(ch), 'records to delete')
PY
aws route53 change-resource-record-sets --hosted-zone-id $ZONE --change-batch "file://$BK/delete.json" --profile $PROFILE --query 'ChangeInfo.Status' --output text

# 3. Attach the hostnames to the Mumbo prod stack.
cd "$(dirname "$0")/infra"
npx cdk deploy -c env=prod -c attach=true --profile $PROFILE --no-notices --require-approval never
for h in app api; do echo "$h.mumbo.si -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 30 https://$h.mumbo.si/)"; done
