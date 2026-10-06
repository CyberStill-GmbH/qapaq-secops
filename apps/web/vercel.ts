const apiOrigin = process.env.QAPAQ_API_ORIGIN;
const rewrites = apiOrigin
  ? (() => {
      const origin = new URL(apiOrigin);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      ) {
        throw new Error(
          'QAPAQ_API_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment.',
        );
      }
      return [{ source: '/api/:path*', destination: `${origin.origin}/api/:path*` }];
    })()
  : [];

export const config = { rewrites };
