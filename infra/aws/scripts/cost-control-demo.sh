#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_ACCOUNT='955200662475'
readonly EXPECTED_REGION='us-east-1'
readonly EXPECTED_CLUSTER='qapaq-secops-demo'
readonly RDS_ID='qapaq-secops-demo-postgres'
readonly EC2_NAME='qapaq-secops-demo-wazuh'
readonly STATE_BUCKET='qapaq-secops-terraform-state-955200662475'
readonly ECS_SERVICES=(worker api krakend)
readonly ECS_ADDRESSES=(
  'module.runtime.aws_ecs_service.worker'
  'module.runtime.aws_ecs_service.api'
  'module.runtime.aws_ecs_service.krakend'
)

fail() { echo "::error::$*"; exit 1; }
log() { echo "::notice::$*"; }

[[ "${GITHUB_REF:-}" == 'refs/heads/main' ]] || fail 'Run this workflow from main only.'
[[ "${AWS_REGION:-}" == "$EXPECTED_REGION" ]] || fail "Unexpected AWS region: ${AWS_REGION:-unset}."
[[ "${OPERATION:-}" == stop || "${OPERATION:-}" == resume ]] || fail 'Operation must be stop or resume.'
if [[ "$OPERATION" == stop ]]; then
  [[ "${CONFIRMATION:-}" == 'STOP-QAPAQ-DEMO' ]] || fail 'Confirmation must be STOP-QAPAQ-DEMO.'
else
  [[ "${CONFIRMATION:-}" == 'RESUME-QAPAQ-DEMO' ]] || fail 'Confirmation must be RESUME-QAPAQ-DEMO.'
fi

actual_account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$actual_account" == "$EXPECTED_ACCOUNT" ]] || fail "Refusing AWS account $actual_account; expected $EXPECTED_ACCOUNT."

cd infra/aws
terraform init -input=false -no-color
[[ "$(terraform workspace show)" == default ]] || fail 'Refusing a non-default Terraform workspace.'
terraform_state="$(terraform state list)"
state_contains() { grep -Fxq "$1" <<< "$terraform_state"; }
state_contains 'module.database.aws_db_instance.this' || fail 'RDS resource is not in the expected Terraform state.'
state_contains 'module.wazuh_public.aws_instance.this' || fail 'Wazuh EC2 resource is not in the expected Terraform state.'
for address in "${ECS_ADDRESSES[@]}"; do
  state_contains "$address" || fail "ECS resource is absent from Terraform state: $address."
done

aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null || fail 'Terraform state bucket is not accessible.'
terraform output -json s3_bucket_names > /tmp/qapaq-s3-buckets.json
while IFS= read -r bucket; do
  [[ -n "$bucket" ]] || fail 'Terraform returned an empty data bucket name.'
  aws s3api head-bucket --bucket "$bucket" >/dev/null || fail "Data bucket is missing or inaccessible: $bucket."
done < <(jq -r 'to_entries[] | .value' /tmp/qapaq-s3-buckets.json)

secret_names() {
  aws secretsmanager list-secrets \
    --filters Key=name,Values=qapaq-secops/demo \
    --query 'SecretList[].Name' --output json | jq -c 'sort'
}
secret_snapshot="$(secret_names)"
secret_count="$(jq 'length' <<< "$secret_snapshot")"
(( secret_count > 0 )) || fail 'No QAPAQ demo secrets were found; refusing to proceed.'
aws secretsmanager describe-secret --secret-id qapaq-secops/demo/entra/client-secret \
  --query Name --output text >/dev/null || fail 'The existing Entra secret is missing.'

rds_before="$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)"
[[ "$rds_before" != None ]] || fail "RDS instance $RDS_ID was not found."
rds_encrypted="$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" \
  --query 'DBInstances[0].StorageEncrypted' --output text)"
[[ "$rds_encrypted" == True ]] || fail 'RDS storage is not encrypted; refusing to stop the database.'
rds_arn="$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" \
  --query 'DBInstances[0].DBInstanceArn' --output text)"
rds_tags="$(aws rds list-tags-for-resource --resource-name "$rds_arn" --output json)"
jq -e 'any(.TagList[]; .Key == "Project" and .Value == "qapaq-secops") and any(.TagList[]; .Key == "Environment" and .Value == "demo")' \
  <<< "$rds_tags" >/dev/null || fail 'RDS tags do not match the expected QAPAQ demo resource.'

mapfile -t ec2_ids < <(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$EC2_NAME" 'Name=tag:Project,Values=qapaq-secops' \
    'Name=tag:Environment,Values=demo' 'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | sed '/^$/d')
(( ${#ec2_ids[@]} == 1 )) || fail "Expected one tagged Wazuh instance, found ${#ec2_ids[@]}."
readonly EC2_ID="${ec2_ids[0]}"
ec2_state="$(aws ec2 describe-instances --instance-ids "$EC2_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)"
volume_ids_json="$(aws ec2 describe-instances --instance-ids "$EC2_ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' --output json)"
[[ "$(jq 'length' <<< "$volume_ids_json")" -gt 0 ]] || fail 'Wazuh has no attached EBS volumes; refusing to stop it.'
while IFS= read -r volume_id; do
  [[ -n "$volume_id" ]] || continue
  volume="$(aws ec2 describe-volumes --volume-ids "$volume_id" --output json)"
  jq -e --arg iid "$EC2_ID" '.Volumes | length == 1 and .[0].Encrypted == true and any(.[0].Attachments[]; .InstanceId == $iid and .State == "attached")' \
    <<< "$volume" >/dev/null || fail "Wazuh EBS volume is not encrypted and attached as expected: $volume_id."
done < <(jq -r '.[]' <<< "$volume_ids_json")

valkey_status="$(aws elasticache describe-replication-groups \
  --replication-group-id qapaq-secops-demo-valkey \
  --query 'ReplicationGroups[0].Status' --output text)"
[[ "$valkey_status" != None ]] || fail 'Expected Valkey replication group was not found.'

verify_persistent_data() {
  aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null || fail 'Terraform state bucket is no longer accessible.'
  while IFS= read -r bucket; do
    [[ -n "$bucket" ]] || continue
    aws s3api head-bucket --bucket "$bucket" >/dev/null || fail "Data bucket is no longer accessible: $bucket."
  done < <(jq -r 'to_entries[] | .value' /tmp/qapaq-s3-buckets.json)
  [[ "$(secret_names)" == "$secret_snapshot" ]] || fail 'Secret names changed during the operation; inspect before continuing.'
  [[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].DBInstanceIdentifier' --output text)" == "$RDS_ID" ]] || fail 'RDS metadata is missing.'
  current_volumes="$(aws ec2 describe-instances --instance-ids "$EC2_ID" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' --output json)"
  [[ "$(jq -c 'sort' <<< "$current_volumes")" == "$(jq -c 'sort' <<< "$volume_ids_json")" ]] || fail 'Wazuh EBS attachments changed.'
  while IFS= read -r volume_id; do
    [[ -n "$volume_id" ]] || continue
    volume="$(aws ec2 describe-volumes --volume-ids "$volume_id" --output json)"
    jq -e --arg iid "$EC2_ID" '.Volumes | length == 1 and .[0].Encrypted == true and any(.[0].Attachments[]; .InstanceId == $iid and .State == "attached")' \
      <<< "$volume" >/dev/null || fail "Persistent EBS volume check failed: $volume_id."
  done < <(jq -r '.[]' <<< "$current_volumes")
}

set_ecs_count() {
  local service="$1" count="$2" current desired
  [[ "$count" == 0 || "$count" == 1 ]] || fail "Unsupported count for $service: $count."
  current="$(aws ecs describe-services --cluster "$EXPECTED_CLUSTER" --services "qapaq-secops-demo-$service" \
    --query 'services[0].desiredCount' --output text)"
  [[ "$current" != None ]] || fail "ECS service qapaq-secops-demo-$service was not found."
  if [[ "$current" != "$count" ]]; then
    aws ecs update-service --cluster "$EXPECTED_CLUSTER" --service "qapaq-secops-demo-$service" \
      --desired-count "$count" --query 'service.{name:serviceName,desired:desiredCount}' --output json \
      | tee -a "$GITHUB_STEP_SUMMARY"
  else
    log "ECS $service already has desired count $count; no update needed."
  fi

  aws ecs wait services-stable --cluster "$EXPECTED_CLUSTER" --services "qapaq-secops-demo-$service"
  desired="$(aws ecs describe-services --cluster "$EXPECTED_CLUSTER" --services "qapaq-secops-demo-$service" \
    --query 'services[0].desiredCount' --output text)"
  [[ "$desired" == "$count" ]] || fail "ECS $service desired count is $desired; expected $count."
  if [[ "$count" == 0 ]]; then
    aws ecs describe-services --cluster "$EXPECTED_CLUSTER" --services "qapaq-secops-demo-$service" \
      --query 'services[0].{running:runningCount,pending:pendingCount}' --output json \
      | jq -e '.running == 0 and .pending == 0' >/dev/null || fail "ECS $service still has running or pending tasks."
  fi
}

get_ec2_state() {
  aws ec2 describe-instances --instance-ids "$EC2_ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}

wait_rds_stopped() {
  local attempt status
  for attempt in $(seq 1 80); do
    status="$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" \
      --query 'DBInstances[0].DBInstanceStatus' --output text)"
    case "$status" in
      stopped) log 'RDS reached stopped state.'; return 0 ;;
      stopping|available) ;;
      *) fail "RDS entered unexpected state $status while stopping." ;;
    esac
    if (( attempt % 4 == 0 )); then
      log "Waiting for RDS to stop ($attempt/80 checks)."
    fi
    sleep 15
  done
  fail 'RDS did not reach stopped state within 20 minutes.'
}

if [[ "$OPERATION" == stop ]]; then
  log "Preflight passed: account=$actual_account, region=$EXPECTED_REGION, RDS=$rds_before, EC2=$ec2_state, secret_count=$secret_count, Valkey=$valkey_status."
  for service in "${ECS_SERVICES[@]}"; do
    set_ecs_count "$service" 0
  done

  rds_status="$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].DBInstanceStatus' --output text)"
  case "$rds_status" in
    available) aws rds stop-db-instance --db-instance-identifier "$RDS_ID" >/dev/null; wait_rds_stopped ;;
    stopped) ;;
    stopping) wait_rds_stopped ;;
    *) fail "RDS is in unexpected state $rds_status; ECS has been scaled down, but no further stop was attempted." ;;
  esac

  ec2_status="$(get_ec2_state)"
  case "$ec2_status" in
    running) aws ec2 stop-instances --instance-ids "$EC2_ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$EC2_ID" ;;
    stopped) ;;
    stopping) aws ec2 wait instance-stopped --instance-ids "$EC2_ID" ;;
    *) fail "Wazuh EC2 is in unexpected state $ec2_status; data checks are required before continuing." ;;
  esac

  verify_persistent_data
  [[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].DBInstanceStatus' --output text)" == stopped ]] || fail 'RDS is not stopped.'
  [[ "$(get_ec2_state)" == stopped ]] || fail 'Wazuh EC2 is not stopped.'
  for service in "${ECS_SERVICES[@]}"; do
    aws ecs describe-services --cluster "$EXPECTED_CLUSTER" --services "qapaq-secops-demo-$service" \
      --query 'services[0].{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}' --output json \
      | jq -e '.desired == 0 and .running == 0 and .pending == 0' >/dev/null || fail "ECS service $service is not fully stopped."
  done
  log 'Stop completed. ECS, RDS and Wazuh EC2 are stopped; S3, Secrets Manager, Terraform state and encrypted Wazuh EBS volumes are still present.'
else
  log "Preflight passed: account=$actual_account, region=$EXPECTED_REGION, RDS=$rds_before, EC2=$ec2_state, secret_count=$secret_count, Valkey=$valkey_status."
  if [[ "$rds_before" == stopped ]]; then
    aws rds start-db-instance --db-instance-identifier "$RDS_ID" >/dev/null
  elif [[ "$rds_before" != available ]]; then
    fail "RDS is in unexpected state $rds_before; refusing resume."
  fi
  aws rds wait db-instance-available --db-instance-identifier "$RDS_ID"

  case "$ec2_state" in
    stopped) aws ec2 start-instances --instance-ids "$EC2_ID" >/dev/null ;;
    running) ;;
    *) fail "Wazuh EC2 is in unexpected state $ec2_state; refusing resume." ;;
  esac
  aws ec2 wait instance-status-ok --instance-ids "$EC2_ID"

  set_ecs_count api 1
  set_ecs_count krakend 1
  set_ecs_count worker 1
  verify_persistent_data
  log 'Resume completed. RDS is available, Wazuh EC2 passed instance status checks, and all ECS services are stable at one task.'
fi

echo >> "$GITHUB_STEP_SUMMARY"
echo "Operation: **$OPERATION**" >> "$GITHUB_STEP_SUMMARY"
echo "AWS account/region: `$actual_account/$EXPECTED_REGION`" >> "$GITHUB_STEP_SUMMARY"
echo "Persistent data checks: Terraform state bucket, three configured S3 data buckets, unchanged Secrets Manager name set, existing RDS instance, encrypted attached Wazuh EBS volumes." >> "$GITHUB_STEP_SUMMARY"
echo 'No resource deletion, secret value read, snapshot deletion, DNS update, Terraform destroy, or Valkey mutation was performed.' >> "$GITHUB_STEP_SUMMARY"
