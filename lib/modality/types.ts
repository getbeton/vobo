import type { CSSProperties, ReactNode, Ref } from 'react';

/** Queue modalities (ARD §7). The registry itself is open to other ids. */
export const QUEUE_MODALITIES = ['text', 'code', 'table', 'image'] as const;
export type QueueModality = (typeof QUEUE_MODALITIES)[number];
export const DEFAULT_MODALITY: QueueModality = 'text';

/**
 * Document pane for the review station. Text wraps the existing ArtifactPane.
 * Other modalities register a pane with the same chrome contract.
 */
export interface ReviewPaneProps {
  side?: 'left' | 'right';
  onMouseUp?: () => void;
  paneRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  style?: CSSProperties;
}

export type ComparePaneProps = ReviewPaneProps;

export type CompareMark = {
  start: number;
  end: number;
  state: string;
  low: boolean;
  focused: boolean;
};
