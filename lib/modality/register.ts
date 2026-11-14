import { registerRenderer, type ArtifactRenderer } from './renderers';
import { registerSelector, type SelectorEngine } from './selectors';

export interface ModalityModule extends ArtifactRenderer {
  id: string;
  classify: SelectorEngine['classify'];
}

/** Register a renderer + selector engine under one id. Tests use this to add a modality without touching core. */
export function registerModality(mod: ModalityModule): void {
  registerRenderer(mod.id, { ReviewPane: mod.ReviewPane, ComparePane: mod.ComparePane });
  registerSelector(mod.id, { classify: mod.classify });
}
