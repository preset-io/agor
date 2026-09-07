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
