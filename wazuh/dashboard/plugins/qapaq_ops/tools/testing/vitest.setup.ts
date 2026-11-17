import { vi } from 'vitest';

// Existing plugin specs use Jest globals because OSD's Jest harness supplies them.
(globalThis as typeof globalThis & { jest: typeof vi }).jest = vi;
