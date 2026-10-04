import { redirect } from '@sveltejs/kit';
import { latestBalance } from '#lib/server/account/balance.js';
import { getPlatformServices } from '#lib/server/platform/runtime.js';
import { loadOnboardingState } from '#lib/server/settings/onboarding-gate.js';
import type { OperationsSettings } from '#lib/server/settings/operations-settings.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ url, depends }) => {
  depends('app:account-balance');
  const platform = await getPlatformServices();
  const onboarding = await loadOnboardingState(platform);
  // Keep browser navigation in onboarding until the user explicitly completes or dismisses it.
  // API routes do not run layout loads, so they are unaffected.
  if (!onboarding.completed && url.pathname !== '/welcome') {
    redirect(307, '/welcome');
  }
  const activeJobs =
    platform.database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM jobs WHERE local_phase IN ('queued','validating','uploading','submission_prepared','submitting','monitoring','downloading')"
      )
      .get()?.count ?? 0;
  const themeDefault =
    platform.settings.get<OperationsSettings>('operations')?.value.theme?.defaultMode ?? 'light';
  return {
    shellSummary: {
      activeJobs,
      balance: latestBalance(platform.database),
      apiKey: { status: (await platform.apiKey.status()).status },
      publicIpv4Status: await platform.publicIpv4.status()
    },
    onboarding,
    themeDefault
  };
};
