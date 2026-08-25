# Judge quality gates (VOBO-49)

DeepEval lives here as a Python package, never imported by the TypeScript runtime.

- `baselines.json` is the recorded precision/recall bar. A drop is a red build, not a moving goalpost.
- Update baselines only with an explicit commit.
- Live-model jobs use a CI-only key with a spend cap. The mocked path in `tests/integration/judge-runner.test.ts` runs on every PR with zero provider calls.

```
pip install deepeval
deepeval test run eval/test_judge_gates.py
```
