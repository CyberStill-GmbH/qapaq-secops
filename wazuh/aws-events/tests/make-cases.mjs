// Genera los casos de wazuh-logtest a partir de eventos EventBridge sintéticos pasados por el MISMO
// normalize() del receptor (así las reglas se prueban contra la forma real de las líneas JSONL).
//   node wazuh/aws-events/tests/make-cases.mjs   → aws-cases.jsonl + aws-expected-rules.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../receiver/sns-receiver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = '061098277310';
const SSO = {
  type: 'AssumedRole',
  arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_SOC-PowerUser_x/analista@example.test`,
  accountId: ACCOUNT,
  sessionContext: { sessionIssuer: { userName: 'AWSReservedSSO_SOC-PowerUser_x' } },
};
const IAMUSER = { type: 'IAMUser', userName: 'ci-deploy', arn: `arn:aws:iam::${ACCOUNT}:user/ci-deploy`, accountId: ACCOUNT };
const ROOT = { type: 'Root', arn: `arn:aws:iam::${ACCOUNT}:root`, accountId: ACCOUNT };
const SERVICE = { type: 'AWSService', invokedBy: 'cloudformation.amazonaws.com' };

let n = 0;
function api(source, eventName, { region = 'us-east-1', ui = SSO, rp = {}, ip = '198.51.100.20' } = {}) {
  n += 1;
  return {
    version: '0',
    id: `case-${n}`,
    'detail-type': 'AWS API Call via CloudTrail',
    source: `aws.${source.split('.')[0]}`,
    account: ACCOUNT,
    time: '2026-11-04T10:00:00Z',
    region,
    resources: [],
    detail: {
      eventVersion: '1.10',
      eventName,
      eventSource: source,
      eventType: 'AwsApiCall',
      readOnly: false,
      awsRegion: region,
      sourceIPAddress: ip,
      userAgent: 'aws-cli/2.x',
      userIdentity: ui,
      requestParameters: rp,
      recipientAccountId: ACCOUNT,
    },
  };
}
function signin(ui, result, mfa, ip = '203.0.113.50') {
  n += 1;
  return {
    id: `case-${n}`,
    'detail-type': 'AWS Console Sign In via CloudTrail',
    source: 'aws.signin',
    account: ACCOUNT,
    region: 'us-east-1',
    time: '2026-11-04T10:00:00Z',
    detail: {
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      eventType: 'AwsConsoleSignIn',
      sourceIPAddress: ip,
      userIdentity: ui,
      responseElements: { ConsoleLogin: result },
      additionalEventData: { MFAUsed: mfa, LoginTo: 'https://console.aws.amazon.com/' },
    },
  };
}
const gd = (severity) => ({
  'detail-type': 'GuardDuty Finding',
  source: 'aws.guardduty',
  account: ACCOUNT,
  region: 'us-east-1',
  detail: { id: `gd-${severity}`, type: 'Recon:EC2/PortProbeUnprotectedPort', severity, title: 'Puerto sondeado', resource: { resourceType: 'Instance', instanceDetails: { instanceId: 'i-0abc' } } },
});
const sh = (label) => ({
  'detail-type': 'Security Hub Findings - Imported',
  source: 'aws.securityhub',
  account: ACCOUNT,
  region: 'us-east-1',
  detail: { findings: [{ Id: `sh-${label}`, Title: `Control ${label}`, Severity: { Label: label }, ProductName: 'Security Hub', Resources: [{ Type: 'AwsS3Bucket', Id: 'arn:aws:s3:::x' }] }] },
});
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:qapaq-soc-dev-aws-events`;
const fail = signin({ type: 'IAMUser', userName: 'victima', accountId: ACCOUNT }, 'Failure', 'No', '192.0.2.66');

export const CASES = [
  [signin(ROOT, 'Success', 'Yes'), '101605'],
  [signin(IAMUSER, 'Success', 'No'), '101609'],
  [signin(SSO, 'Success', 'No'), '101610'],
  [fail, '101607'],
  [fail, '101607'],
  [fail, '101607'],
  [fail, '101607'],
  [fail, '101608'],
  [api('iam.amazonaws.com', 'CreateAccessKey', { ui: ROOT }), '101606'],
  [api('ec2.amazonaws.com', 'RunInstances', { region: 'eu-west-1' }), '101612'],
  [api('cloudformation.amazonaws.com', 'CreateStack', { region: 'ap-south-1', ui: SERVICE }), '101613'],
  [api('ec2.amazonaws.com', 'CreateSecurityGroup', { region: 'sa-east-1' }), '101611'],
  [api('cloudtrail.amazonaws.com', 'StopLogging', { rp: { name: 'qapaq-trail' } }), '101620'],
  [api('cloudtrail.amazonaws.com', 'UpdateTrail', { rp: { name: 'qapaq-trail' } }), '101621'],
  [api('guardduty.amazonaws.com', 'DeleteDetector'), '101622'],
  [api('securityhub.amazonaws.com', 'DisableSecurityHub'), '101623'],
  [api('config.amazonaws.com', 'StopConfigurationRecorder'), '101624'],
  [api('access-analyzer.amazonaws.com', 'DeleteAnalyzer'), '101625'],
  [api('iam.amazonaws.com', 'TagRole'), '101630'],
  [api('iam.amazonaws.com', 'CreateAccessKey', { rp: { userName: 'ci-deploy' } }), '101631'],
  [api('iam.amazonaws.com', 'AttachRolePolicy', { rp: { roleName: 'x', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' } }), '101632'],
  [api('sso.amazonaws.com', 'CreateAccountAssignment'), '101634'],
  [api('sso.amazonaws.com', 'TagResource'), '101633'],
  [api('organizations.amazonaws.com', 'InviteAccountToOrganization'), '101635'],
  [api('organizations.amazonaws.com', 'LeaveOrganization'), '101636'],
  [api('ec2.amazonaws.com', 'CreateSecurityGroup', { rp: { groupName: 'qapaq-e2e' } }), '101640'],
  [api('ec2.amazonaws.com', 'AuthorizeSecurityGroupIngress', { rp: { groupId: 'sg-1', ipPermissions: { items: [{ fromPort: 22, ipRanges: { items: [{ cidrIp: '0.0.0.0/0' }] } }] } } }), '101641'],
  [api('ec2.amazonaws.com', 'CreateNetworkAclEntry'), '101642'],
  [api('ec2.amazonaws.com', 'CreateRoute'), '101643'],
  [api('ec2.amazonaws.com', 'DeleteFlowLogs'), '101644'],
  [api('ec2.amazonaws.com', 'ModifySnapshotAttribute'), '101645'],
  [api('ec2.amazonaws.com', 'RunInstances'), '101646'],
  [api('s3.amazonaws.com', 'PutBucketPolicy', { rp: { bucketName: 'b', bucketPolicy: { Statement: [{ Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` } }] } } }), '101650'],
  [api('s3.amazonaws.com', 'DeleteBucketPublicAccessBlock', { rp: { bucketName: 'b' } }), '101651'],
  [api('s3.amazonaws.com', 'PutBucketPolicy', { rp: { bucketName: 'b', bucketPolicy: { Statement: [{ Principal: '*', Action: 's3:GetObject' }] } } }), '101652'],
  [api('kms.amazonaws.com', 'PutKeyPolicy'), '101655'],
  [api('kms.amazonaws.com', 'DisableKey'), '101656'],
  [api('kms.amazonaws.com', 'ScheduleKeyDeletion'), '101657'],
  [api('sns.amazonaws.com', 'DeleteTopic', { rp: { topicArn: TOPIC } }), '101615'],
  [api('sns.amazonaws.com', 'TagResource', { rp: { resourceArn: TOPIC, tags: [{ key: 'qapaq-e2e', value: '1' }] } }), '101616'],
  [api('dynamodb.amazonaws.com', 'CreateTable'), '101602'],
  [gd(2), '101661'],
  [gd(5.5), '101662'],
  [gd(8), '101663'],
  [gd(9.5), '101664'],
  [sh('LOW'), '101670'],
  [sh('MEDIUM'), '101671'],
  [sh('HIGH'), '101672'],
  [sh('CRITICAL'), '101673'],
  [{ 'detail-type': 'AWS Health Event', source: 'aws.health', account: ACCOUNT, region: 'us-east-1', detail: { eventTypeCode: 'X' } }, '101603'],
];

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const lines = [];
  const expected = [];
  CASES.forEach(([event, rule], i) => {
    const [rec] = normalize(event, { messageId: `case-${i + 1}`, topicArn: TOPIC, receivedAt: '2026-11-04T10:00:00.000Z' });
    lines.push(JSON.stringify(rec));
    expected.push(rule);
  });
  fs.writeFileSync(path.join(here, 'aws-cases.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(here, 'aws-expected-rules.txt'), `${expected.join('\n')}\n`);
  console.log(`${lines.length} casos escritos`);
}
