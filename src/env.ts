import { defineEnvVars } from '@sveltejs/kit/env';

// SvelteKit 3 exposes only declared variables through `$app/env/private`; an undeclared name reads
// as undefined. Each schema returns the raw value, so an unset variable stays undefined and the
// existing defaults in the code keep applying. The env-declarations unit test keeps this list in
// step with the names the server code reads.
const optional = { schema: (value: string | undefined) => value };

export const variables = defineEnvVars({
  PLS_APP_DATA_DIR: optional,
  PLS_LOG_MAX_AGE_MS: optional,
  PLS_LOG_MAX_BYTES: optional,
  PLS_LOG_MAX_FILES: optional,
  PLS_LOG_RETENTION_AGE_MS: optional,
  PLS_LOG_SEPARATE_ERRORS: optional,
  PLS_TEST_JOB_CREATE_MS: optional,
  PLS_TEST_JOB_POLL_MS: optional,
  PLS_TEST_JOB_WORKER_MS: optional,
  PLS_TEST_MODE: optional,
  PLS_TEST_POYO_BASE_URL: optional,
  PLS_TEST_PUBLIC_IPV4_URL: optional,
  POYO_API_KEY: optional
});
