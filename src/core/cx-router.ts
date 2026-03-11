import { codexAdapter } from '../runtimes/codex.js';
import { routeAdapterCommand } from './adapter-router.js';
import type { RouteResult } from './adapter-router.js';

export type { RouteResult };

export async function routeCxCommand(args: string): Promise<RouteResult> {
  return routeAdapterCommand(codexAdapter, 'cx', args);
}
