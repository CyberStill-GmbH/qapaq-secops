import type { ConfigurationProfileName } from '../configuration.errors.js';

export interface ConfigurationProfile {
  readonly name: ConfigurationProfileName;
  readonly allowLocalInsecureTransport: boolean;
  readonly requireTls: boolean;
  readonly defaults: Readonly<Record<string, string>>;
}
