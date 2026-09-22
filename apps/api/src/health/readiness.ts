/** Cada comprobación futura informa solo de la disponibilidad implementada, sin detalles del proveedor. */
export type ReadinessContributor = () => Promise<boolean>;
export const READINESS_CONTRIBUTORS = Symbol('READINESS_CONTRIBUTORS');
