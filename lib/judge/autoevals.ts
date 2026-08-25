import { ClosedQA, LLMClassifierFromTemplate } from 'autoevals';
import type { CriterionScore, JudgeScorer, ScorerInput } from './scorer';

/**
 * Runtime scorer: autoevals ClosedQA for the pass/fail, plus a classifier that
 * is forced to quote the offending span on FAIL. Braintrust logging stays off
 * — we never import `braintrust`. The key never appears in thrown messages.
 */
function scrub(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.includes(apiKey) ? message.split(apiKey).join('[redacted]') : message;
}

const quoteClassifier = LLMClassifierFromTemplate<{ criterion: string }>({
  name: 'vobo-quote',
  promptTemplate: `You review an artifact against one rubric criterion.

Criterion:
{{criterion}}

Artifact:
{{output}}

If the artifact FAILS the criterion, answer FAIL.
If it PASSES, answer PASS.

On FAIL, the first line of your reasoning MUST be exactly:
QUOTE: "<verbatim substring copied from the artifact>"
On PASS, do not invent a quote.`,
  choiceScores: { PASS: 1, FAIL: 0 },
  useCoT: true,
});

function extractQuote(rationale: string | undefined, content: string): string | null {
  if (!rationale) return null;
  const m = rationale.match(/QUOTE:\s*"([^"]+)"/);
  if (!m) return null;
  const quote = m[1];
  return content.includes(quote) ? quote : null;
}

function auth(input: ScorerInput) {
  return {
    openAiApiKey: input.apiKey,
    openAiBaseUrl: input.baseUrl,
    model: input.modelId,
  };
}

export const autoevalsScorer: JudgeScorer = async (input: ScorerInput) => {
  const dossier = [input.prompt, input.source].filter(Boolean).join('\n\n');
  const out: CriterionScore[] = [];

  for (const criterion of input.criteria) {
    const criteriaText = `${criterion.title}${criterion.description ? `. ${criterion.description}` : ''}`;
    try {
      const closed = await ClosedQA({
        input: dossier || '(no prompt)',
        output: input.contentMd,
        criteria: criteriaText,
        ...auth(input),
      });

      const score = typeof closed?.score === 'number' ? closed.score : 0;
      const passed = score >= input.minScore;
      let quote: string | null = null;
      let note =
        (closed.metadata && closed.metadata['rationale'] != null
          ? String(closed.metadata['rationale'])
          : '') || (passed ? 'pass' : 'fail');

      if (!passed) {
        const quoted = await quoteClassifier({
          output: input.contentMd,
          criterion: criteriaText,
          ...auth(input),
        });
        const rationale =
          quoted.metadata && quoted.metadata['rationale'] != null
            ? String(quoted.metadata['rationale'])
            : '';
        quote = extractQuote(rationale, input.contentMd);
        note = rationale || note;
      }

      out.push({
        criterionKey: criterion.key,
        score,
        passed,
        quote,
        note: scrub(String(note).slice(0, 2000), input.apiKey),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(scrub(message, input.apiKey));
    }
  }
  return out;
};
