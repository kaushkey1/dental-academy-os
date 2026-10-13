import serverless from 'serverless-http';
import type { Handler } from '@netlify/functions';
import { connectLambda } from '@netlify/blobs';
import { createApp } from '../../server/app.ts';
import { runtimeDatabase } from '../../server/netlify-runtime.ts';

let adapter: ReturnType<typeof serverless> | undefined;
export const handler: Handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
  adapter ??= serverless(createApp(await runtimeDatabase()), {
    basePath: '/.netlify/functions/api',
    binary: ['application/pdf', 'image/png', 'image/jpeg', 'application/octet-stream'],
  });
  return (await adapter(event, context)) as any;
};
