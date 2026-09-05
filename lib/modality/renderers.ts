import type { ComponentType } from 'react';
import type { ComparePaneProps, ReviewPaneProps } from './types';

export interface ArtifactRenderer {
  ReviewPane: ComponentType<ReviewPaneProps>;
  ComparePane: ComponentType<ComparePaneProps>;
}

const renderers = new Map<string, ArtifactRenderer>();

export function registerRenderer(id: string, renderer: ArtifactRenderer): void {
  renderers.set(id, renderer);
}

export function getRenderer(id: string): ArtifactRenderer {
  const renderer = renderers.get(id);
  if (!renderer) {
    throw new Error(`No renderer registered for modality '${id}'`);
  }
  return renderer;
}
