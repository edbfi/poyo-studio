import { REMOTE_CLEANUP_CAPABILITY } from '../../features/cleanup/contracts';
import type { SettingsDto } from '../../features/settings/contracts';
import { DEFAULT_MEDIA_PRIVACY_SETTINGS } from '../../features/settings/media-privacy';
import { DEFAULT_CLEANUP_POLICY } from '../cleanup/policy';
import type { AppPaths } from '../platform/app-paths';
import type { ApiKeyStatusDto } from './api-key-manager';
import { DEFAULT_OPERATIONS_SETTINGS } from './operations-settings';

export function buildSettingsDto(paths: AppPaths, apiKey: ApiKeyStatusDto): SettingsDto {
  return {
    apiKey,
    storage: {
      source: paths.source
    },
    ...DEFAULT_OPERATIONS_SETTINGS,
    mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
    localCleanup: DEFAULT_CLEANUP_POLICY,
    remoteCleanup: REMOTE_CLEANUP_CAPABILITY
  };
}
