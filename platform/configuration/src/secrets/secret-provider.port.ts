import type { SecretReference } from './secret-reference.js';

export interface SecretProvider {
  resolve(reference: SecretReference): Promise<string>;
}
