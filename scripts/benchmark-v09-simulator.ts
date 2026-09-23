import type { JevRequest } from '../src/types.ts';

/**
 * The v4 response simulator recognizes the semantic route question, rather
 * than assuming its original object key still describes its identity.
 */
export type V4SimulatorFeatures = { renamed: boolean; reordered: boolean; metadata: boolean };

export function v4SimulatorFeatures(request: JevRequest): V4SimulatorFeatures {
  const semanticRoutes = Object.entries(request.questions).filter(([, question]) => question.instructions === 'Route.');
  if (semanticRoutes.length !== 1) throw new Error(`invalid v4 simulator request: expected exactly one semantic Route question, found ${semanticRoutes.length}`);

  const [actualRouteId] = semanticRoutes[0]!;
  const renamed = actualRouteId !== 'route';
  const reordered = Object.keys(request.questions).indexOf(actualRouteId) !== 0;
  const state = request.state;
  const metadata = state !== null && typeof state === 'object' && Object.hasOwn(state, 'benchmark_metadata');

  return { renamed, reordered, metadata };
}

export function v4SimulatorActive(family: string, request: JevRequest): boolean {
  const { renamed, reordered, metadata } = v4SimulatorFeatures(request);
  // Keep the historical order criterion exactly: any Choice question may carry it.
  const criteria = Object.values(request.questions).some(question => question.type === 'choice' && Object.keys(question.criteria)[0] === 'general');
  if (family === 'order') return renamed && (criteria || metadata);
  if (family === 'metadata') return renamed && metadata;
  if (family === 'interaction2') return renamed && reordered;
  if (family === 'interaction3') return renamed && reordered && metadata;
  if (family === 'rareconfident') return renamed && metadata && Number((request.state as { seed?: number }).seed) % 11 === 0;
  if (family === 'policy-confidence') return renamed && criteria;
  if (family === 'policy-choice') return renamed && reordered;
  return false;
}
