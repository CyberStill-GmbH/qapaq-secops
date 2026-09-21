import { configurationError, type ConfigurationProfileName } from '../configuration.errors.js';
import { DEVELOPMENT_PROFILE } from './development.profile.js';
import { PRODUCTION_PROFILE } from './production.profile.js';
import { TEST_PROFILE } from './test.profile.js';
import type { ConfigurationProfile } from './profile.js';

export const CONFIGURATION_PROFILES = ['development', 'test', 'production'] as const;

const profiles: Readonly<Record<ConfigurationProfileName, ConfigurationProfile>> = Object.freeze({
  development: DEVELOPMENT_PROFILE,
  test: TEST_PROFILE,
  production: PRODUCTION_PROFILE,
});

export function selectProfile(value: unknown): ConfigurationProfile {
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw configurationError('CONFIG_PROFILE_INVALID', 'QAPAQ_PROFILE');
  }
  return profiles[value];
}

export type { ConfigurationProfile } from './profile.js';
