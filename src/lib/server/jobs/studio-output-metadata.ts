import type { StudioOutputDto } from '../../features/generation/contracts';
import type { JobDetailDto } from '../../features/library/contracts';

/** Finished tasks expose output metadata for download repair before local verification completes. */
export function studioOutputMetadata(
  detail: Pick<JobDetailDto, 'remoteStatus' | 'outputs'>
): StudioOutputDto[] {
  if (detail.remoteStatus !== 'finished') return [];
  return detail.outputs.map((output) => ({
    outputId: output.outputId,
    mediaKind: output.mediaKind,
    mediaUrl: output.mediaUrl,
    aspectRatio: output.aspectRatio,
    pixelWidth: output.pixelWidth,
    pixelHeight: output.pixelHeight,
    fileName: output.fileName,
    downloadState: output.downloadState,
    localAvailable: output.localAvailable,
    downloadCopyRequestedAt: output.downloadCopyRequestedAt ?? null,
    downloadCopyRequestCount: output.downloadCopyRequestCount ?? 0
  }));
}
