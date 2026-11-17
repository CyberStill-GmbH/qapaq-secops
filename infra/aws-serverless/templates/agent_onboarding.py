"""Onboarding de agentes Wazuh en instancias EC2 (solo stdlib + boto3).

Se dispara por EventBridge (EC2 Instance State-change Notification = running) y por un barrido
diario de EventBridge Scheduler. Para cada instancia en ejecución cuyo tag de agente no sea
"disabled" (y, en modo "tag", sea "enabled"):

1. Si no tiene perfil de instancia, le asocia el perfil base (SSM core + enrolamiento).
2. Si ya tiene un rol, le adjunta la política gestionada de enrolamiento.
3. En modo "all", pone el tag <agente>=enabled para que la asociación SSM la incluya.

Lo que no puede arreglar (p. ej. perfiles sin rol, permisos denegados) se notifica por SNS.
"""

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

EC2 = boto3.client("ec2")
IAM = boto3.client("iam")
SNS = boto3.client("sns")

AGENT_TAG = os.environ["AGENT_TAG_KEY"]
TARGET_MODE = os.environ["TARGET_MODE"]
BASELINE_PROFILE_ARN = os.environ["BASELINE_PROFILE_ARN"]
BASELINE_PROFILE_NAME = os.environ["BASELINE_PROFILE_NAME"]
ENROLL_POLICY_ARN = os.environ["ENROLL_POLICY_ARN"]
ALERT_TOPIC_ARN = os.environ.get("ALERT_TOPIC_ARN", "")


def handler(event, _context):
    instance_ids = None
    if event.get("detail-type") == "EC2 Instance State-change Notification":
        instance_ids = [event["detail"]["instance-id"]]

    results, problems = [], []
    for instance in _running_instances(instance_ids):
        instance_id = instance["InstanceId"]
        try:
            outcome = _process(instance)
            results.append({"instance": instance_id, **outcome})
            if outcome.get("problem"):
                problems.append(f"{instance_id}: {outcome['problem']}")
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "Unknown")
            LOG.warning("Fallo en %s: %s", instance_id, code)
            problems.append(f"{instance_id}: {code}")

    if problems and ALERT_TOPIC_ARN:
        SNS.publish(
            TopicArn=ALERT_TOPIC_ARN,
            Subject="Onboarding de agentes Wazuh: acciones pendientes",
            Message="No se pudo preparar el enrolamiento automático de:\n" + "\n".join(problems),
        )

    LOG.info(json.dumps({"processed": len(results), "problems": len(problems)}))
    return {"results": results, "problems": problems}


def _running_instances(instance_ids):
    kwargs = {"Filters": [{"Name": "instance-state-name", "Values": ["running"]}]}
    if instance_ids:
        kwargs["InstanceIds"] = instance_ids
    for page in EC2.get_paginator("describe_instances").paginate(**kwargs):
        for reservation in page["Reservations"]:
            yield from reservation["Instances"]


def _process(instance):
    instance_id = instance["InstanceId"]
    tags = {t["Key"]: t["Value"] for t in instance.get("Tags", [])}
    state = tags.get(AGENT_TAG, "")

    if state == "disabled":
        return {"skipped": "disabled"}
    if TARGET_MODE == "tag" and state != "enabled":
        return {"skipped": "not-tagged"}

    actions = []
    profile = instance.get("IamInstanceProfile")
    if not profile:
        EC2.associate_iam_instance_profile(
            IamInstanceProfile={"Arn": BASELINE_PROFILE_ARN}, InstanceId=instance_id
        )
        actions.append("associated-baseline-profile")
    else:
        profile_name = profile["Arn"].rsplit("/", 1)[-1]
        if profile_name != BASELINE_PROFILE_NAME:
            roles = IAM.get_instance_profile(InstanceProfileName=profile_name)["InstanceProfile"]["Roles"]
            if not roles:
                return {"actions": actions, "problem": f"perfil {profile_name} sin rol"}
            for role in roles:
                if not _has_policy(role["RoleName"]):
                    IAM.attach_role_policy(RoleName=role["RoleName"], PolicyArn=ENROLL_POLICY_ARN)
                    actions.append(f"attached-enroll-policy:{role['RoleName']}")

    if TARGET_MODE == "all" and state != "enabled":
        EC2.create_tags(Resources=[instance_id], Tags=[{"Key": AGENT_TAG, "Value": "enabled"}])
        actions.append("tagged-enabled")

    return {"actions": actions}


def _has_policy(role_name):
    paginator = IAM.get_paginator("list_attached_role_policies")
    for page in paginator.paginate(RoleName=role_name):
        if any(p["PolicyArn"] == ENROLL_POLICY_ARN for p in page["AttachedPolicies"]):
            return True
    return False
