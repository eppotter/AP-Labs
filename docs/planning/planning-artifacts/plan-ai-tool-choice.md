# Plan: ai-tool-choice (T3)

**Status:** approved by Ely 2026-10-25.

## The problem

In Ely's live check (2026-10-25), **Read my request** always fell back to the form. The bot's log showed `ai call failed … status 400`. The API's message was: `tool_choice: type "tool" and "any" are not supported for this model.`

- `kit/runtime/llm/index.js` sends `tool_choice: { type: 'tool', name }` to force the one extraction tool.
- Claude Sonnet 5.5, the profile's `extraction_model`, rejects forced tool use. So do Opus 5.5 and Fable 5.1.
- Story 9.4's tests passed because the fake client never checks `tool_choice`.

## The fix (one story, one PR)

1. In `call()`, send `tool_choice: { type: 'auto', disable_parallel_tool_use: true }` instead of the forced choice.
   - The tool is still the only one sent.
   - The system prompt already says "Answer only by calling the one tool you are given" (`REQUEST_RULE`).
   - A reply without the tool call already returns `toolInput: null`, so the form opens with "I couldn't read your request".
   - `ask({ tool })` changes the same way.
2. The fake Anthropic client used by the tests rejects `tool_choice` of type `tool` or `any` with a 400 (`BadRequestError`), the same as the real API. A unit test asserts that `call()` never sends them.
3. Update the comments and `docs/runtime/ai-setup.md`, where they say the tool is "forced".

## Acceptance

- With the real key: in Slack, `clients in the North zone whose plan lapsed in the last 90 days, top 25` reads as Zone north, 90, 25. Already tested directly against the API, 3 of 3 (`stop_reason: tool_use`, 97 output tokens).
- A reply with text only and no tool call still falls back to the form (existing test).
- `npm run check && npm test` pass.

## Not doing

- `strict: true` on the tool. Strict mode needs every property listed in `required`, and our fields are optional by design. `checkGiven` already validates every value.
- Structured outputs (`output_config.format`). A bigger change, not needed.
- Changing the model.

## Tier

`kit/runtime/llm/**` is T3 in the Brightside profile.
