import { registerRenderer } from '@/lib/modality/renderers';
import { ArtifactPane } from './ArtifactPane';

/** Text is the built-in. Other modalities register without touching this file. */
registerRenderer('text', {
  ReviewPane: ArtifactPane,
  ComparePane: ArtifactPane,
});
