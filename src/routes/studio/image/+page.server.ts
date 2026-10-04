import { loadStudioData } from '#lib/server/generation/studio-data.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) =>
  loadStudioData('image', {
    presetId: url.searchParams.get('preset'),
    fromJobId: url.searchParams.get('fromJob'),
    sourceOutputId: url.searchParams.get('sourceOutput')
  });
