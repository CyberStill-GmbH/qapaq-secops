import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

it('Ankay edge mount is optional, preflighted and protected by the existing QAPAQ session', () => {
  const edge = read('wazuh/edge/qapaq-edge.conf');
  const route = read('wazuh/edge/qapaq-ankay.location.conf');
  const deploy = read('wazuh/edge/apply-edge.sh');

  expect(edge).toContain('${ANKAY_LOCATION}');
  expect(route).toContain('location ^~ /ankay/');
  expect(route).toContain('auth_request /_qapaq/introspect;');
  expect(route).toContain('error_page 401 = @qapaq_sign_in;');
  expect(route).toContain('error_page 403 = @qapaq_forbidden;');
  expect(route).toContain('proxy_pass http://${ANKAY_UPSTREAM}/;');
  expect(route).toContain('X-Forwarded-Prefix /ankay;');
  expect(deploy).toContain('ANKAY_UPSTREAM');
  expect(deploy).toContain('[[ "$ankay_code" == 200 ]]');
  expect(deploy).toContain('302 https://$SOC_HOSTNAME/qapaq/login?nextUrl=/ankay/');
});
