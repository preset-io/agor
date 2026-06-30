# Codex pricing snapshot

`litellm-openai-model-prices.json` is a filtered vendored snapshot of LiteLLM's model pricing map:

https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

Only entries whose `litellm_provider` is `openai` are kept to avoid vendoring the full upstream multi-provider catalog. It is used only for **estimated** Codex API-equivalent costs. OpenAI/Codex SDK
responses do not currently include a per-turn `cost_usd` field. Refresh this
snapshot periodically from the upstream URL, then run the Codex normalizer tests.
