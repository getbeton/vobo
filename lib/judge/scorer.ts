export interface CriterionSpec {
  key: string;
  title: string;
  description: string | null;
}

export interface CriterionScore {
  criterionKey: string;
  score: number;
  passed: boolean;
  quote: string | null;
  note: string;
}

export interface ScorerInput {
  contentMd: string;
  prompt: string;
  source: string;
  criteria: CriterionSpec[];
  modelId: string;
  baseUrl: string;
  apiKey: string;
  minScore: number;
}

export type JudgeScorer = (input: ScorerInput) => Promise<CriterionScore[]>;
