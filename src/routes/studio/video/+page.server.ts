import { loadStudioData } from '#lib/server/generation/studio-data.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) =>
  loadStudioData('video', {
    presetId: url.searchParams.get('preset'),
    fromJobId: url.searchParams.get('fromJob'),
    sourceOutputId: url.searchParams.get('sourceOutput')
  });
