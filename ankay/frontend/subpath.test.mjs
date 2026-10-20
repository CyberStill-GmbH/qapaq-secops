import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixSource } from './subpath.mjs';

test('prefixes upstream route and navigation patterns under /ankay', () => {
  const source = [
    'window.location.pathname.startsWith("/login")',
    '<Route path="/workflows" />',
    'navigate("/apps")',
    'navigate(`/settings`)',
    '<a href="/docs">docs</a>',
    '<Link to="/dashboard" />',
    'const path = "/admin";',
    'const globalUrl = window.location.origin;',
    'const url = `${window.location.origin}/api/v1/health`;',
  ].join('\n');
  assert.equal(
    prefixSource(source),
    [
      'window.location.pathname.startsWith("/ankay/login")',
      '<Route path="/ankay/workflows" />',
      'navigate("/ankay/apps")',
      'navigate(`/ankay/settings`)',
      '<a href="/ankay/docs">docs</a>',
      '<Link to="/ankay/dashboard" />',
      'const path = "/ankay/admin";',
      'const globalUrl = "/ankay";',
      'const url = `/ankay/api/v1/health`;',
    ].join('\n'),
  );
});

test('is idempotent for an already prefixed bundle and leaves external URLs alone', () => {
  const source = [
    'navigate("/ankay/workflows")',
    '<img src="https://assets.example.test/logo.svg" />',
    'const url = "https://shuffler.io/docs";',
  ].join('\n');
  assert.equal(prefixSource(prefixSource(source)), prefixSource(source));
  assert.equal(prefixSource(source), source);
});
