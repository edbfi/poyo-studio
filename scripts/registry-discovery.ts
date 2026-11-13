export type ModelModality = 'image' | 'video';

export interface IndexedModelPage {
  modality: ModelModality;
  pageSlug: string;
}

/** Only model documents count: overview pages and other services are not generation models. */
export function indexedModelPages(body: string): IndexedModelPage[] {
  const pages = new Map<string, IndexedModelPage>();
  for (const match of body.matchAll(
    /https:\/\/docs\.poyo\.ai\/api-manual\/(image|video)-series\/([a-zA-Z0-9._-]+)\.md(?=[\s)#?]|$)/g
  )) {
    const modality = match[1] as ModelModality;
    const pageSlug = match[2];
    if (!pageSlug || pageSlug === 'overview') continue;
    pages.set(`${modality}:${pageSlug}`, { modality, pageSlug });
  }
  return [...pages.values()].sort((left, right) =>
    `${left.modality}:${left.pageSlug}`.localeCompare(`${right.modality}:${right.pageSlug}`)
  );
}

export function missingIndexedModels(
  body: string,
  known: Readonly<Record<ModelModality, readonly string[]>>
): IndexedModelPage[] {
  return indexedModelPages(body).filter((page) => !known[page.modality].includes(page.pageSlug));
}
