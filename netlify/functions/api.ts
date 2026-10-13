import type { Handler } from '@netlify/functions';
import { connectLambda } from '@netlify/blobs';
import { createApp } from '../../server/app.ts';
import { runtimeDatabase } from '../../server/netlify-runtime.ts';
import { netlifyHttp } from '../../server/netlify-http.ts';

let adapter: ReturnType<typeof netlifyHttp> | undefined;
export const handler: Handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
  adapter ??= netlifyHttp(createApp(await runtimeDatabase()));
  return await adapter(event, context);
};
