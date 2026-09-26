# Codex pricing snapshot

`litellm-openai-model-prices.json` is a filtered vendored snapshot of LiteLLM's model pricing map:

https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

Only entries whose `litellm_provider` is `openai` are kept to avoid vendoring the full upstream multi-provider catalog. It is used only for **estimated** Codex API-equivalent costs. OpenAI/Codex SDK
responses do not currently include a per-turn `cost_usd` field. Refresh this
snapshot periodically from the upstream URL, then run the Codex normalizer tests.

The `gpt-6-astra` entry is supplemented from OpenAI's
[model reference](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[pricing table](https://developers.openai.com/api/docs/pricing), checked on
2026-09-04. Standard per-million-token rates are $10 input, $1 cached input,
and $50 output; requests above 272k input tokens use $20, $2, and $75 respectively.
The estimator uses standard base rates because cumulative SDK usage does not
identify individual requests crossing the long-context threshold.

The `gpt-6-sol` and `gpt-6-luna` entries are supplemented from OpenAI's
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) model
references, checked on 2026-09-22. Standard per-million-token rates are $2 input,
$0.20 cached input, and $10 output for Sol, and $0.10 input, $0.01 cached input,
and $0.50 output for Luna. Requests above 272k input tokens use 2x input and cache
rates and 1.5x output; the estimator uses base rates for the same reason as Astra.
