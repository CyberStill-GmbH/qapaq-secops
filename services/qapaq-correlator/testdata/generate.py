import json, sys, datetime as dt
out = sys.argv[1]
base = dt.datetime(2026, 11, 4, 10, 0, 0, tzinfo=dt.timezone.utc)
docs = []
n = [0]


def ts(minutes):
    return (base + dt.timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%S.000+0000')


def alert(minutes, rule, level, groups, desc, agent=('000', 'qapaq-manager', None), data=None, tactics=None):
    n[0] += 1
    a = {'id': agent[0], 'name': agent[1]}
    if agent[2]:
        a['ip'] = agent[2]
    r = {'id': rule, 'level': level, 'groups': groups, 'description': desc}
    if tactics:
        r['mitre'] = {'tactic': tactics}
    d = {'timestamp': ts(minutes), 'id': '1762250400.%05d' % n[0], 'rule': r, 'agent': a}
    if data:
        d['data'] = data
    docs.append(d)


web = ('002', 'qapaq-web-01', '10.89.0.20')
node = ('001', 'qapaq-soc-dev-node', '10.89.0.10')
ep = ('003', 'pc-ep-a', '10.89.0.30')
# Stage 1-3: Cloudflare WAF block -> edge scan -> SSH brute force (same IP).
alert(0, '101501', 6, ['cloudflare', 'waf'], 'QAPAQ Cloudflare: WAF blocked a request',
      data={'qapaq': {'vendor': 'cloudflare'}, 'cloudflare': {'zone_name': 'example.test', 'firewall': {'action': 'block', 'client_ip': '203.0.113.77', 'path': '/login'}}})
alert(20, '31151', 10, ['web', 'accesslog', 'attack'], 'Multiple web server 400 error codes from same source ip', agent=web,
      data={'srcip': '203.0.113.77', 'url': '/wp-login.php'}, tactics=['Reconnaissance'])
for i in range(5):
    alert(40 + i, '5710', 5, ['syslog', 'sshd', 'invalid_login', 'authentication_failed'], 'sshd: Attempt to login using a non-existent user',
          agent=node, data={'srcip': '203.0.113.77', 'srcuser': 'admin'}, tactics=['Credential Access'])
alert(45, '5712', 10, ['syslog', 'sshd', 'authentication_failures'], 'sshd: brute force trying to get access to the system', agent=node,
      data={'srcip': '203.0.113.77'}, tactics=['Credential Access'])
# Credential failures -> success -> privileged change (AWS SSO session = UPN) + M365 sign-in.
arn = 'arn:aws:sts::061098277310:assumed-role/AWSReservedSSO_SOC-PowerUser_abc123/victima@qapaq.pe'
alert(110, '91545', 3, ['office365', 'authentication_success'], 'Office 365: UserLoggedIn',
      data={'office365': {'UserId': 'Victima@QAPAQ.pe', 'Operation': 'UserLoggedIn', 'ClientIP': '198.51.100.7'}})
for i in range(3):
    alert(120 + i, '101710', 5, ['aws', 'authentication_failed'], 'QAPAQ AWS: console sign-in failure',
          data={'qapaq': {'vendor': 'aws'}, 'aws': {'event_name': 'ConsoleLogin', 'console_login': 'Failure', 'principal_arn': arn, 'source_ip': '198.51.100.7'}},
          tactics=['Credential Access'])
alert(125, '101711', 3, ['aws', 'authentication_success'], 'QAPAQ AWS: console sign-in',
      data={'qapaq': {'vendor': 'aws'}, 'aws': {'event_name': 'ConsoleLogin', 'console_login': 'Success', 'principal_arn': arn, 'source_ip': '198.51.100.7'}},
      tactics=['Initial Access'])
alert(150, '101640', 12, ['aws', 'qapaq_privilege_escalation'], 'QAPAQ AWS: managed policy attached to a user',
      data={'qapaq': {'vendor': 'aws'}, 'aws': {'event_name': 'AttachUserPolicy', 'principal_arn': arn, 'source_ip': '198.51.100.7',
                                               'request_parameters': '{"userName":"backdoor","policyArn":"arn:aws:iam::aws:policy/AdministratorAccess"}'}},
      tactics=['Privilege Escalation', 'Persistence'])
# Endpoint: Bitdefender protection disabled then malware; Wazuh agent with the same private IP.
alert(240, '60106', 3, ['windows', 'authentication_success'], 'Windows logon success', agent=ep,
      data={'win': {'system': {'computer': 'PC-EP-A.corp.example', 'eventID': '4624'}, 'eventdata': {'targetUserName': 'jdoe', 'ipAddress': '10.89.0.30'}}})
alert(250, '101720', 10, ['bitdefender'], 'QAPAQ Bitdefender: antimalware protection disabled',
      data={'qapaq': {'vendor': 'bitdefender'}, 'bitdefender': {'endpoint': {'name': 'PC-EP-A', 'fqdn': 'pc-ep-a.corp.example', 'ip': '10.89.0.30', 'antimalware_disabled': True}}},
      tactics=['Defense Evasion'])
alert(280, '101721', 12, ['bitdefender', 'malware'], 'QAPAQ Bitdefender: endpoint infected',
      data={'qapaq': {'vendor': 'bitdefender'}, 'bitdefender': {'endpoint': {'name': 'PC-EP-A', 'fqdn': 'pc-ep-a.corp.example', 'ip': '10.89.0.30', 'infected': True}}},
      tactics=['Execution'])
# Noise on the SOC node: repeated rootcheck (level 7) and sudo (level 3): grouped and dampened.
for i in range(20):
    alert(300 + i * 10, '510', 7, ['ossec', 'rootcheck'], 'Host-based anomaly detection event (rootcheck).', agent=node)
for i in range(30):
    alert(300 + i * 5, '5402', 3, ['syslog', 'sudo'], 'Successful sudo to ROOT executed.', agent=node, data={'srcuser': 'ubuntu', 'dstuser': 'root'})
# A document without rule (must be skipped as unparseable).
docs.append({'timestamp': ts(500), 'id': 'broken'})
docs.sort(key=lambda d: (d['timestamp'], d['id']))
with open(out + '/wazuh-alerts.jsonl', 'w', newline='\n') as f:
    for d in docs:
        f.write(json.dumps(d, sort_keys=True) + '\n')


def qapaq(i, rule, prio, keys, at, verdict='', status='new', upd=None):
    return {'id': '00000000-0000-4000-8000-%012d' % i, 'ruleId': rule, 'title': 'alert ' + rule, 'priority': prio,
            'status': status, 'verdict': verdict, 'signal': 'other', 'entityKeys': keys, 'incidentId': '',
            'occurredAt': at, 'updatedAt': upd or at}


alerts = []
i = 0
# Feedback: rule 101501 on a benign scanner IP marked FP four times (allowlist proposal).
for k in range(4):
    i += 1
    alerts.append(qapaq(i, '101501', 'P3', ['ip:192.0.2.200'], '2026-11-03T0%d:00:00.000Z' % k, 'false_positive', 'closed', '2026-11-03T0%d:30:00.000Z' % k))
# A P1 rule with FPs: review only, never suppressed.
for k in range(3):
    i += 1
    alerts.append(qapaq(i, '100502', 'P1', ['user:breakglass@qapaq.pe'], '2026-11-03T1%d:00:00.000Z' % k, 'benign', 'closed', '2026-11-03T1%d:20:00.000Z' % k))
# Mixed verdicts: 3 FP + 2 TP -> ratio 0.6 -> no proposal.
for k in range(5):
    i += 1
    alerts.append(qapaq(i, '5712', 'P2', ['ip:198.51.100.50'], '2026-11-02T0%d:00:00.000Z' % k, 'false_positive' if k < 3 else 'true_positive', 'closed', '2026-11-02T0%d:10:00.000Z' % k))
# Analyst-facing alerts during the incident window: one user, one IP, one rule without entity.
for k in range(6):
    i += 1
    alerts.append(qapaq(i, ['101710', '101710', '101710', '101711', '101640', '91545'][k], 'P2', ['user:victima@qapaq.pe', 'ip:198.51.100.7'], '2026-11-04T12:%02d:00.000Z' % (k * 5)))
for k in range(4):
    i += 1
    alerts.append(qapaq(i, '5712', 'P2', ['ip:203.0.113.77'], '2026-11-04T10:%02d:00.000Z' % (40 + k)))
for k in range(5):
    i += 1
    alerts.append(qapaq(i, '510', 'P3', [], '2026-11-04T1%d:%02d:00.000Z' % (5 + k // 3, (k % 3) * 10)))
with open(out + '/qapaq-alerts.json', 'w', newline='\n') as f:
    json.dump({'items': alerts, 'truncated': False}, f, indent=1, sort_keys=True)
print(len(docs), len(alerts))
