import { isIP } from 'node:net';
import serverless from 'serverless-http';
import type { HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';

export function netlifyHttp(
  app: Parameters<typeof serverless>[0],
): (event: HandlerEvent, context: HandlerContext) => Promise<HandlerResponse> {
  const adapter = serverless(app, {
    basePath: '/.netlify/functions/api',
    binary: ['application/pdf', 'image/png', 'image/jpeg', 'application/octet-stream'],
  });
  return async (event, context) => {
    // Lambda compatibility events lack API Gateway's sourceIp. Use the header
    // Netlify overwrites at ingress; never use a caller-supplied forwarding chain.
    const header = Object.entries(event.headers).find(
      ([key]) => key.toLowerCase() === 'x-nf-client-connection-ip',
    )?.[1];
    const sourceIp = typeof header === 'string' && isIP(header) ? header : '0.0.0.0';
    return (await adapter(
      {
        ...event,
        requestContext: { identity: { sourceIp } },
      },
      context,
    )) as any;
  };
}
