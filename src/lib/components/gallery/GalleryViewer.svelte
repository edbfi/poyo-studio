<script lang="ts">
import { Dialog } from 'bits-ui';
import { onMount, untrack } from 'svelte';
import {
  type BoundSnapshot,
  initialViewerLifecycleState,
  reduceViewerLifecycle,
  type ViewerLifecycleCommand,
  type ViewerLifecycleEvent
} from '$lib/features/gallery/viewer-lifecycle';
import {
  type CaptureIdentity,
  DISCRETE_ZOOM_FACTOR,
  type ElementToken,
  elementToken,
  KEYBOARD_PAN,
  KEYBOARD_PAN_FAST,
  normalizeWheelDelta,
  type Point,
  reduceViewerTransform,
  type ViewerSession,
  wheelZoomFactor
} from '$lib/features/gallery/viewer-transform';
import type {
  GalleryViewerItemDto,
  LibraryGroupDto,
  SafeMediaSummary
} from '$lib/features/library/contracts';
import { dateTimeLabel } from '$lib/features/library/presentation';
import { downloadCopy } from '$lib/features/library/attachment-request';
import {
  latestDownloadRequestAt,
  mergeDownloadRequest,
  type DownloadRequestUpdate
} from '$lib/features/library/download-request-sync';

type ViewableGroup = LibraryGroupDto & {
  representative: SafeMediaSummary & { mediaUrl: string };
};

interface Props {
  groups: LibraryGroupDto[];
  items?: GalleryViewerItemDto[] | undefined;
  complete?: boolean;
  updating?: boolean;
  selectedMediaWarning?: string | null;
  sequenceError?: string | null;
  onRetry?: () => void;
  open?: boolean;
  selectedOutputId?: string | null;
  triggerElement?: HTMLElement | null;
  downloadRequests?: ReadonlyMap<string, string>;
  ondownloadaccepted?: (update: DownloadRequestUpdate) => void;
  fallbackFocusElement?: HTMLElement | null;
}

interface Registration {
  generation: number;
  outputId: string;
  token: ElementToken;
  element: HTMLImageElement | HTMLVideoElement;
}

let {
  groups,
  items,
  complete = true,
  updating = false,
  selectedMediaWarning = null,
  sequenceError = null,
  onRetry,
  open = $bindable(false),
  selectedOutputId = $bindable<string | null>(null),
  triggerElement = $bindable<HTMLElement | null>(null),
  downloadRequests: synchronizedDownloadRequests = new Map(),
  ondownloadaccepted,
  fallbackFocusElement = null
}: Props = $props();
let lifecycle = $state(initialViewerLifecycleState());
let session = $state<ViewerSession>({ status: 'ended', generation: 0 });
let imageToolbar = $state<HTMLElement | null>(null);
let viewport = $state<HTMLDivElement | null>(null);
let image = $state<HTMLImageElement | null>(null);
let video = $state<HTMLVideoElement | null>(null);
let registration = $state<Registration | null>(null);
let reducedMotion = $state(false);
let interactionMessage = $state('');
let downloadPending = $state<string | null>(null);
let downloadFeedback = $state('');
let downloadRequests = $state(new Map<string, string>());
let captureIds = new Map<number, CaptureIdentity[]>();
let focusBeforeOpen: HTMLElement | null = null;
let wasOpen = false;
let captureSerial = 0;
let tokenCounter = 0;
let resizeFrame = $state<{ id: number; generation: number } | null>(null);
let resizeTransitionFrame = $state<{ id: number; generation: number } | null>(null);
let resizing = $state(false);
let lastViewport = { width: 0, height: 0 };

function sequenceGroup(item: GalleryViewerItemDto): ViewableGroup {
  return {
    jobId: item.jobId,
    entryKey: null,
    displayName: item.displayName,
    provider: item.provider,
    modality: item.mediaKind,
    workflow: item.workflow,
    publicModelId: '',
    promptExcerpt: item.promptExcerpt,
    createdAt: item.createdAt,
    completedAt: null,
    outputCount: 1,
    verifiedOutputCount: 1,
    totalBytes: 0,
    favorite: false,
    pinned: false,
    aspectRatio: null,
    warning: null,
    tags: [],
    representative: {
      outputId: item.outputId,
      mediaKind: item.mediaKind,
      contentType: null,
      fileName: null,
      pixelWidth: null,
      pixelHeight: null,
      downloadState: 'verified',
      mediaUrl: item.mediaUrl,
      downloadCopyRequestedAt: item.downloadCopyRequestedAt ?? null,
      downloadCopyRequestCount: item.downloadCopyRequestCount ?? 0
    }
  };
}

let viewableGroups = $derived(items ? items.map(sequenceGroup) : groups.filter(isViewable));
let activeIndex = $derived(
  viewableGroups.findIndex((group) => group.representative.outputId === selectedOutputId)
);
let activeGroup = $derived(activeIndex >= 0 ? viewableGroups[activeIndex] : null);
let canGoPrevious = $derived(complete && activeIndex > 0);
let canGoNext = $derived(complete && activeIndex >= 0 && activeIndex < viewableGroups.length - 1);
let readyImage = $derived(session.status === 'ready-image' ? session : null);
let readyVideo = $derived(session.status === 'ready-video' ? session : null);
let activeDownloadRequestedAt = $derived(
  activeGroup
    ? latestDownloadRequestAt(
        downloadRequests.get(activeGroup.representative.outputId),
        synchronizedDownloadRequests.get(activeGroup.representative.outputId),
        activeGroup.representative.downloadCopyRequestedAt
      )
    : null
);
let imagePannable = $derived(
  Boolean(
    readyImage &&
      (readyImage.geometry.fitted.width * readyImage.transform.zoom >
        readyImage.geometry.viewport.width ||
        readyImage.geometry.fitted.height * readyImage.transform.zoom >
          readyImage.geometry.viewport.height)
  )
);
let imageInteracting = $derived(
  Boolean(readyImage && (readyImage.pointers.length > 0 || readyImage.pendingLayout || resizing))
);
let contentClass = $derived(
  `${reducedMotion ? 'gallery-viewer-reduced-motion ' : ''}gallery-viewer-content bg-stage text-stage-foreground shadow-[var(--shadow-overlay)]`
);

function isViewable(group: LibraryGroupDto): group is ViewableGroup {
  return Boolean(group.representative?.mediaUrl);
}

function requestActiveDownload(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
  if (!activeGroup || downloadPending) return;
  const outputId = activeGroup.representative.outputId;
  const focusTarget = event.currentTarget;
  downloadPending = outputId;
  downloadFeedback = '';
  void downloadCopy(outputId, {
    onaccepted: ({ requestedAt }) => {
      const update = { outputId, requestedAt };
      const merged = mergeDownloadRequest(downloadRequests, update);
      if (merged) downloadRequests = merged;
      ondownloadaccepted?.(update);
      downloadFeedback = 'Download copy requested.';
      downloadPending = null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const dialog = viewport?.closest('[role="dialog"]');
        if (focusTarget.isConnected && !dialog?.contains(active)) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    },
    onerror: () => {
      downloadFeedback = 'Download copy request failed.';
      downloadPending = null;
    }
  });
}

function pointFor(event: PointerEvent | WheelEvent | MouseEvent): Point {
  const rect = viewport?.getBoundingClientRect();
  return {
    x: event.clientX - (rect?.left ?? 0) - (rect?.width ?? 0) / 2,
    y: event.clientY - (rect?.top ?? 0) - (rect?.height ?? 0) / 2
  };
}

function viewportCenter(): Point {
  return { x: 0, y: 0 };
}

function matchingRegistration(
  element: HTMLImageElement | HTMLVideoElement | null
): Registration | null {
  return registration?.element === element && lifecycle.live?.generation === registration.generation
    ? registration
    : null;
}

function dispatch(action: Parameters<typeof reduceViewerTransform>[1]): void {
  session = reduceViewerTransform(session, action);
}

function cancelAsync(generation: number): void {
  if (resizeFrame?.generation === generation) {
    cancelAnimationFrame(resizeFrame.id);
    resizeFrame = null;
  }
  if (resizeTransitionFrame?.generation === generation) {
    cancelAnimationFrame(resizeTransitionFrame.id);
    resizeTransitionFrame = null;
    resizing = false;
  }
}

function execute(commands: ViewerLifecycleCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case 'PAUSE_MEDIA':
        if (
          registration?.generation === command.generation &&
          registration.outputId === command.outputId &&
          registration.token === command.token &&
          registration.element instanceof HTMLVideoElement
        )
          registration.element.pause();
        break;
      case 'END_SESSION':
        dispatch({ type: 'END', generation: command.generation });
        break;
      case 'CANCEL_ASYNC':
        cancelAsync(command.generation);
        break;
      case 'RELEASE_CAPTURES':
        releaseCaptures(true);
        break;
      case 'CLEAR_MEDIA_REGISTRATION':
        if (
          registration?.generation === command.generation &&
          registration.outputId === command.outputId &&
          (!command.token || registration.token === command.token)
        )
          registration = null;
        break;
      case 'BEGIN_ITEM':
        interactionMessage = '';
        dispatch({
          type: 'BEGIN',
          generation: command.generation,
          outputId: command.outputId,
          mediaKind: command.mediaKind
        });
        break;
      case 'WRITE_SELECTED_OUTPUT':
        selectedOutputId = command.outputId;
        break;
      case 'WRITE_OPEN_FALSE':
        open = false;
        break;
      default: {
        const exhaustive: never = command;
        throw new Error(`Unhandled viewer lifecycle command: ${exhaustive}`);
      }
    }
  }
}

function lifecycleEvent(event: ViewerLifecycleEvent): void {
  const result = reduceViewerLifecycle(lifecycle, event);
  lifecycle = result.state;
  execute(result.commands);
}

function syncLifecycle(snapshot: BoundSnapshot): void {
  lifecycleEvent({ type: 'SYNC_SNAPSHOT', snapshot });
}

$effect.pre(() => {
  if (open && !wasOpen)
    focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen = open;
  const snapshot: BoundSnapshot =
    activeGroup && open
      ? {
          open: true,
          renderable: true,
          outputId: activeGroup.representative.outputId,
          mediaKind: activeGroup.representative.mediaKind
        }
      : { open, renderable: false, outputId: null };
  untrack(() => syncLifecycle(snapshot));
});

function moveSelection(delta: -1 | 1, focusTarget?: HTMLElement): void {
  const next = viewableGroups[activeIndex + delta];
  if (!next) return;
  const dialog = viewport?.closest('[role="dialog"]');
  const candidate =
    focusTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusedBefore = candidate && dialog?.contains(candidate) ? candidate : null;
  const handoffFocus =
    activeGroup?.representative.mediaKind === 'image' &&
    next.representative.mediaKind === 'video' &&
    imageToolbar?.contains(document.activeElement);
  lifecycleEvent({
    type: 'REQUEST_SELECTION',
    outputId: next.representative.outputId,
    mediaKind: next.representative.mediaKind
  });
  if (focusedBefore) {
    const restoreSelectionFocus = () => {
      const becameDisabled = focusedBefore instanceof HTMLButtonElement && focusedBefore.disabled;
      if (handoffFocus || becameDisabled || !focusedBefore.isConnected) viewport?.focus();
      else focusedBefore.focus();
    };
    restoreSelectionFocus();
    requestAnimationFrame(restoreSelectionFocus);
  }
}

function requestClose(reason: 'button' | 'escape' | 'outside'): void {
  lifecycleEvent({ type: 'REQUEST_CLOSE', reason });
}

function restoreTrigger(event: Event): void {
  const target = triggerElement;
  const captured = focusBeforeOpen;
  triggerElement = null;
  focusBeforeOpen = null;
  const destination = target?.isConnected
    ? target
    : fallbackFocusElement?.isConnected
      ? fallbackFocusElement
      : captured?.isConnected
        ? captured
        : null;
  if (destination) {
    event.preventDefault();
    destination.focus();
  }
}

function ignoresViewerKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, select, textarea, audio, video') || target.isContentEditable)
  );
}
function announceImageState(): void {
  const current = session;
  if (current.status !== 'ready-image') return;
  interactionMessage =
    current.mode === 'fit'
      ? 'Fit'
      : current.mode === 'actual'
        ? 'Actual size, 100 percent'
        : `Custom zoom, ${Math.round(current.transform.zoom * 100)} percent`;
}

function fitImage(): void {
  dispatch({ type: 'FIT' });
  announceImageState();
}

function actualImage(): void {
  dispatch({ type: 'ACTUAL' });
  announceImageState();
}

function handleKeydown(event: KeyboardEvent): void {
  if (
    !open ||
    !activeGroup ||
    !viewport?.closest('[role="dialog"]')?.contains(event.target as Node) ||
    ignoresViewerKeys(event.target) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const imageSession = readyImage;
  if (imageSession) {
    if (event.key === '=' || event.key === '+') {
      zoom(DISCRETE_ZOOM_FACTOR);
      event.preventDefault();
      return;
    }
    if (event.key === '-' || event.key === '_') {
      zoom(1 / DISCRETE_ZOOM_FACTOR);
      event.preventDefault();
      return;
    }
    if (event.key === '0' && !event.shiftKey) {
      fitImage();
      event.preventDefault();
      return;
    }
    if (event.key === '1' && !event.shiftKey) {
      actualImage();
      event.preventDefault();
      return;
    }
    if (viewport?.contains(event.target as Node)) {
      const fast = event.shiftKey ? KEYBOARD_PAN_FAST : KEYBOARD_PAN;
      const overflowX =
        imageSession.geometry.fitted.width * imageSession.transform.zoom >
        imageSession.geometry.viewport.width;
      const overflowY =
        imageSession.geometry.fitted.height * imageSession.transform.zoom >
        imageSession.geometry.viewport.height;
      const delta =
        event.key === 'ArrowLeft' && overflowX
          ? { x: fast, y: 0 }
          : event.key === 'ArrowRight' && overflowX
            ? { x: -fast, y: 0 }
            : event.key === 'ArrowUp' && overflowY
              ? { x: 0, y: fast }
              : event.key === 'ArrowDown' && overflowY
                ? { x: 0, y: -fast }
                : null;
      if (delta) {
        dispatch({ type: 'PAN', delta });
        announceImageState();
        event.preventDefault();
        return;
      }
      if (event.shiftKey && event.key.startsWith('Arrow')) return;
    }
  }
  if (!event.shiftKey && event.key === 'ArrowLeft') {
    moveSelection(-1);
    event.preventDefault();
  } else if (!event.shiftKey && event.key === 'ArrowRight') {
    moveSelection(1);
    event.preventDefault();
  }
}

function releaseCaptures(clearRegistry: boolean): void {
  for (const pointerId of captureIds.keys()) {
    try {
      viewport?.releasePointerCapture(pointerId);
    } catch {}
  }
  if (clearRegistry) captureIds.clear();
}

function scheduleMeasure(): void {
  if (resizeFrame) return;
  const generation = session.generation;
  const id = requestAnimationFrame(() => {
    if (resizeFrame?.id === id) resizeFrame = null;
    measureViewport();
  });
  resizeFrame = { id, generation };
}

function measureViewport(): void {
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return;
  const next = { width: rect.width, height: rect.height };
  if (
    Math.abs(next.width - lastViewport.width) < 0.5 &&
    Math.abs(next.height - lastViewport.height) < 0.5
  )
    return;
  lastViewport = next;
  if (session.status === 'ready-image') {
    const generation = session.generation;
    resizing = true;
    dispatch({ type: 'PREPARE_VIEWPORT_RESIZE', generation });
    if (resizeTransitionFrame) cancelAnimationFrame(resizeTransitionFrame.id);
    const id = requestAnimationFrame(() => {
      if (resizeTransitionFrame?.id === id) {
        resizeTransitionFrame = null;
        resizing = false;
      }
    });
    resizeTransitionFrame = { id, generation };
  }
  releaseCaptures(false);
  if (session.status !== 'ended')
    dispatch({ type: 'RECONCILE_VIEWPORT', generation: session.generation, viewport: next });
}

function attachMedia(element: HTMLImageElement | HTMLVideoElement | null): void {
  if (!element || !lifecycle.live || !activeGroup || matchingRegistration(element)) return;
  const live = lifecycle.live;
  if (live.outputId !== activeGroup.representative.outputId) return;
  const token = elementToken(`gallery-${live.generation}-${++tokenCounter}`);
  lifecycleEvent({
    type: 'REGISTER_MEDIA_ATTACHMENT',
    generation: live.generation,
    outputId: live.outputId,
    mediaKind: live.mediaKind,
    token
  });
  if (lifecycle.live?.attachedToken !== token) return;
  registration = { generation: live.generation, outputId: live.outputId, token, element };
  dispatch({
    type: 'ATTACH_ELEMENT',
    generation: live.generation,
    outputId: live.outputId,
    mediaKind: live.mediaKind,
    token
  });
  if (element instanceof HTMLImageElement && element.complete) mediaReady(element);
  if (element instanceof HTMLVideoElement && element.readyState >= HTMLMediaElement.HAVE_METADATA)
    mediaReady(element);
}

function mediaReady(element: HTMLImageElement | HTMLVideoElement): void {
  const registered = matchingRegistration(element);
  if (!registered || !activeGroup) return;
  const intrinsic =
    element instanceof HTMLImageElement
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : { width: element.videoWidth, height: element.videoHeight };
  dispatch({
    type: 'MEDIA_READY',
    generation: registered.generation,
    outputId: registered.outputId,
    mediaKind: activeGroup.representative.mediaKind,
    token: registered.token,
    intrinsic,
    viewport: lastViewport
  });
}

function mediaError(element: HTMLImageElement | HTMLVideoElement): void {
  const registered = matchingRegistration(element);
  if (registered && activeGroup)
    dispatch({
      type: 'MEDIA_ERROR',
      generation: registered.generation,
      outputId: registered.outputId,
      mediaKind: activeGroup.representative.mediaKind,
      token: registered.token,
      reason: 'Media could not be loaded'
    });
}

function endSessionBeforeComponentDetach(_node: HTMLElement): { destroy: () => void } {
  return {
    destroy: () => lifecycleEvent({ type: 'UNMOUNT' })
  };
}
function handleImageLoad(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) mediaReady(event.currentTarget);
}

function handleImageError(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) mediaError(event.currentTarget);
}

function handleVideoLoadedMetadata(event: Event): void {
  if (event.currentTarget instanceof HTMLVideoElement) mediaReady(event.currentTarget);
}

function handleVideoError(event: Event): void {
  if (event.currentTarget instanceof HTMLVideoElement) mediaError(event.currentTarget);
}

function zoom(factor: number): void {
  if (!readyImage) return;
  dispatch({ type: 'ZOOM', zoom: readyImage.transform.zoom * factor, anchor: viewportCenter() });
  announceImageState();
}

function wheel(event: WheelEvent): void {
  if (!readyImage || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const delta = normalizeWheelDelta(
    event.deltaY,
    event.deltaMode,
    readyImage.geometry.viewport.height
  );
  const factor = delta === undefined ? undefined : wheelZoomFactor(delta);
  if (!factor) return;
  event.preventDefault();
  dispatch({ type: 'ZOOM', zoom: readyImage.transform.zoom * factor, anchor: pointFor(event) });
}

function pointerDown(event: PointerEvent): void {
  if (!readyImage) return;
  dispatch({
    type: 'POINTER_DOWN',
    input: {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      buttons: event.buttons,
      point: pointFor(event),
      at: event.timeStamp
    }
  });
  const current = session;
  const pointer =
    current.status === 'ready-image'
      ? current.pointers.find((candidate) => candidate.pointerId === event.pointerId)
      : undefined;
  if (!pointer) return;
  viewport?.focus({ preventScroll: true });
  try {
    viewport?.setPointerCapture(event.pointerId);
    const capture = {
      generation: pointer.generation,
      pointerId: event.pointerId,
      captureSerial: ++captureSerial,
      interactionEpoch: pointer.interactionEpoch
    };
    captureIds.set(event.pointerId, [...(captureIds.get(event.pointerId) ?? []), capture]);
    dispatch({ type: 'CAPTURE_SUCCEEDED', ...capture });
  } catch {
    dispatch({
      type: 'CAPTURE_FAILED',
      generation: pointer.generation,
      pointerId: event.pointerId,
      captureSerial: 0,
      interactionEpoch: pointer.interactionEpoch
    });
  }
  event.preventDefault();
}

function pointerMove(event: PointerEvent): void {
  if (!readyImage) return;
  const hadCapture = (captureIds.get(event.pointerId)?.length ?? 0) > 0;
  dispatch({
    type: 'POINTER_MOVE',
    pointerId: event.pointerId,
    buttons: event.buttons,
    point: pointFor(event)
  });
  if (hadCapture && session.status === 'ready-image' && session.pointers.length === 0)
    releaseCaptures(false);
  if (readyImage.pointers.some((pointer) => pointer.pointerId === event.pointerId))
    event.preventDefault();
}

function pointerUp(event: PointerEvent): void {
  if (!readyImage) return;
  dispatch({
    type: 'POINTER_UP',
    pointerId: event.pointerId,
    point: pointFor(event),
    at: event.timeStamp
  });
  if (session.status === 'ready-image' && session.pointers.length === 0) releaseCaptures(false);
  else
    try {
      viewport?.releasePointerCapture(event.pointerId);
    } catch {}
  announceImageState();
}

function cancelPointer(event: PointerEvent): void {
  if (!readyImage) return;
  const capture = captureIds.get(event.pointerId)?.at(-1);
  if (!capture) return;
  dispatch({ type: 'POINTER_CANCEL', ...capture });
  releaseCaptures(false);
}

function lostPointerCapture(event: PointerEvent): void {
  const captures = captureIds.get(event.pointerId);
  const capture = captures?.shift();
  if (captures?.length === 0) captureIds.delete(event.pointerId);
  if (readyImage && capture) {
    dispatch({ type: 'LOST_POINTER_CAPTURE', ...capture });
    if (session.status === 'ready-image' && session.pointers.length === 0) releaseCaptures(false);
  }
}

function dblClick(event: MouseEvent): void {
  if (!readyImage) return;
  dispatch({ type: 'DOUBLE_CLICK', point: pointFor(event), at: event.timeStamp });
  announceImageState();
}

$effect(() => {
  attachMedia(image ?? video);
});

onMount(() => {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotion = () => (reducedMotion = media.matches);
  updateMotion();
  media.addEventListener('change', updateMotion);
  window.addEventListener('resize', scheduleMeasure);
  window.addEventListener('orientationchange', scheduleMeasure);
  visualViewport?.addEventListener('resize', scheduleMeasure);
  return () => {
    media.removeEventListener('change', updateMotion);
    window.removeEventListener('resize', scheduleMeasure);
    window.removeEventListener('orientationchange', scheduleMeasure);
    visualViewport?.removeEventListener('resize', scheduleMeasure);
    if (resizeFrame) cancelAnimationFrame(resizeFrame.id);
    if (resizeTransitionFrame) cancelAnimationFrame(resizeTransitionFrame.id);
  };
});

$effect(() => {
  if (!viewport) return;
  const observer = new ResizeObserver(scheduleMeasure);
  observer.observe(viewport);
  scheduleMeasure();
  return () => observer.disconnect();
});

$effect(() => {
  if (!viewport || !readyImage) return;
  const target = viewport;
  target.addEventListener('wheel', wheel, { passive: false });
  return () => target.removeEventListener('wheel', wheel);
});
</script>

<svelte:window onkeydown={handleKeydown} />
<span hidden aria-hidden="true" use:endSessionBeforeComponentDetach></span>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 bg-black/85 backdrop-blur-sm" style="z-index: 70;" />
    <Dialog.Content
      class={contentClass}
      onCloseAutoFocus={restoreTrigger}
      onEscapeKeydown={() => requestClose('escape')}
      onInteractOutside={() => requestClose('outside')}
    >
      {#if activeGroup}
        <div class="gallery-viewer-layout">
          <header class="gallery-viewer-header">
            <div class="min-w-0 flex-1">
              <Dialog.Title class="truncate text-sm font-semibold">{activeGroup.displayName}</Dialog.Title>
              <Dialog.Description class="mt-0.5 truncate text-xs text-stage-muted">
                {activeGroup.provider} · {activeGroup.workflow} · {activeIndex + 1} of {viewableGroups.length}
              </Dialog.Description>
            </div>
            <div class="gallery-viewer-header-controls">
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Previous item" disabled={!canGoPrevious} onclick={(event) => moveSelection(-1, event.currentTarget)}>←</button>
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Next item" disabled={!canGoNext} onclick={(event) => moveSelection(1, event.currentTarget)}>→</button>
              <button class="gallery-viewer-close focus-ring" type="button" onclick={() => requestClose('button')}>Close</button>
              {#if updating}<p class="text-xs text-stage-muted" role="status">Updating Gallery…</p>{/if}
              {#if selectedMediaWarning}<p class="text-xs text-warning" role="alert">{selectedMediaWarning}</p>{/if}
              {#if sequenceError}<div class="flex items-center gap-2 text-xs text-warning" role="alert"><span>Gallery history could not be updated.</span>{#if onRetry}<button class="gallery-viewer-control focus-ring" type="button" onclick={onRetry}>Retry</button>{/if}</div>{/if}
            </div>
          </header>
          {#if activeGroup.representative.mediaKind === 'image'}
            <div bind:this={imageToolbar} class="gallery-viewer-toolbar" role="toolbar" aria-label="Image zoom controls">
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Zoom out" disabled={!readyImage} onclick={() => zoom(1 / DISCRETE_ZOOM_FACTOR)}>−</button>
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Fit image" aria-pressed={readyImage?.mode === 'fit'} disabled={!readyImage} onclick={fitImage}>Fit</button>
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Actual size" aria-pressed={readyImage?.mode === 'actual'} disabled={!readyImage} onclick={actualImage}>Actual</button>
              <button class="gallery-viewer-control focus-ring" type="button" aria-label="Zoom in" disabled={!readyImage} onclick={() => zoom(DISCRETE_ZOOM_FACTOR)}>+</button>
              <output data-testid="gallery-viewer-zoom" aria-label="Zoom level" aria-live="off">{readyImage ? (readyImage.mode === 'actual' ? '100%' : `${Math.round(readyImage.transform.zoom * 100)}%`) : '—'}</output>
            </div>
          {/if}
          <div class="gallery-viewer-stage" data-testid="gallery-viewer-stage">
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -- the named viewport is keyboard-operable for image zoom and pan -->
            <div
              bind:this={viewport}
              class="gallery-viewer-viewport focus-ring"
              class:gallery-viewer-image-ready={Boolean(readyImage)}
              class:gallery-viewer-image-pannable={imagePannable}
              class:gallery-viewer-interacting={imageInteracting}
              tabindex="0"
              role="region"
              aria-label="Media viewport"
              aria-describedby="gallery-viewer-instructions"
              aria-busy={session.status === 'loading'}
              data-testid="gallery-viewer-viewport"
              data-media-kind={activeGroup.representative.mediaKind}
              data-zoom-mode={readyImage?.mode ?? 'none'}
              data-zoom-value={readyImage?.transform.zoom ?? 1}
              data-layout-pending={(readyImage ?? readyVideo)?.pendingLayout ?? false}
              onpointerdown={readyImage ? pointerDown : undefined}
              onpointermove={readyImage ? pointerMove : undefined}
              onpointerup={readyImage ? pointerUp : undefined}
              onpointercancel={readyImage ? cancelPointer : undefined}
              onlostpointercapture={readyImage ? lostPointerCapture : undefined}
              ondblclick={readyImage ? dblClick : undefined}
            >
              {#key activeGroup.representative.outputId}
                {#if activeGroup.representative.mediaKind === 'image'}
                  <img
                    bind:this={image}
                    src={activeGroup.representative.mediaUrl}
                    alt={activeGroup.displayName}
                    decoding="async"
                    class="gallery-viewer-media"
                    class:gallery-viewer-media-ready={Boolean(readyImage)}
                    style={readyImage ? `width:${readyImage.geometry.fitted.width}px;height:${readyImage.geometry.fitted.height}px;transform:translate3d(${readyImage.transform.x}px,${readyImage.transform.y}px,0) scale(${readyImage.transform.zoom});` : ''}
                    onload={handleImageLoad}
                    onerror={handleImageError}
                  />
                {:else}
                  <!-- svelte-ignore a11y_media_has_caption -- generated media does not provide a caption track -->
                  <video
                    bind:this={video}
                    src={activeGroup.representative.mediaUrl}
                    aria-label={activeGroup.displayName}
                    class="gallery-viewer-video"
                    preload="metadata"
                    controls
                    autoplay={false}
                    playsinline
                    style={readyVideo ? `width:${readyVideo.geometry.fitted.width}px;height:${readyVideo.geometry.fitted.height}px;` : ''}
                    onloadedmetadata={handleVideoLoadedMetadata}
                    onerror={handleVideoError}
                  ></video>
                {/if}
              {/key}
              {#if activeDownloadRequestedAt}
                <span
                  class="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-full border border-success/40 bg-background/90 text-success shadow-[var(--shadow-sm)]"
                  role="img"
                  aria-label={`Download copy requested ${dateTimeLabel(activeDownloadRequestedAt)}`}
                  title={`Download copy requested ${dateTimeLabel(activeDownloadRequestedAt)}`}
                >✓<span class="sr-only">Download</span></span>
              {/if}
              {#if session.status === 'loading'}
                <p class="gallery-viewer-state" role="status" data-testid="gallery-viewer-loading">Loading media…</p>
              {/if}
              {#if session.status === 'error'}
                <p class="gallery-viewer-state" role="alert" data-testid="gallery-viewer-error">{session.reason}</p>
              {/if}
            </div>
          </div>
          <footer class="gallery-viewer-footer" data-testid="gallery-viewer-footer">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold uppercase tracking-[0.12em] text-stage-muted">
                  {activeGroup.representative.mediaKind} · {activeIndex + 1} of {viewableGroups.length} ·
                  <time datetime={activeGroup.createdAt}>{dateTimeLabel(activeGroup.createdAt)}</time>
                </p>
                <p class="mt-1 line-clamp-2 text-sm leading-5">{activeGroup.promptExcerpt ?? 'No prompt stored'}</p>
              </div>
              <nav class="flex flex-wrap gap-2" aria-label="Selected media actions">
                <a class="gallery-viewer-action focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" href={`/jobs/${activeGroup.jobId}`}>Open job</a>
                <a class="gallery-viewer-action focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" href={activeGroup.representative.mediaUrl} target="_blank" rel="noreferrer">Open full size</a>
                <button class="gallery-viewer-action focus-ring rounded border border-stage-border px-3 py-2 text-xs font-semibold hover:bg-stage-border" type="button" onclick={requestActiveDownload} disabled={downloadPending !== null}>Download copy</button>
              </nav>
            </div>
            <p id="gallery-viewer-instructions" class="sr-only">Use the zoom controls, mouse wheel, drag, double click, or keyboard shortcuts. Arrow keys pan a zoomed image and otherwise move between items.</p>
            <p class="sr-only" role="status" aria-live="polite" data-testid="gallery-viewer-item-status">{activeGroup.representative.mediaKind}, item {activeIndex + 1} of {viewableGroups.length}: {activeGroup.displayName}</p>
            <p class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="gallery-viewer-interaction-status">{interactionMessage}</p>
            <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{downloadFeedback}</p>
          </footer>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
