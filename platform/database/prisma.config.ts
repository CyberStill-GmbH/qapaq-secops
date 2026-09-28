import { defineConfig } from 'prisma/config';

// Generar y validar no requiere credenciales; migrar sí exige DATABASE_URL.
const databaseUrl = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(databaseUrl === undefined ? {} : { datasource: { url: databaseUrl } }),
});
