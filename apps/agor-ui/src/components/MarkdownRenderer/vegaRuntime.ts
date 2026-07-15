/** Load the heavyweight chart runtime only after a completed Vega-Lite fence renders. */
export async function loadVegaRuntime() {
  const [{ default: vegaEmbed }, { loader }] = await Promise.all([
    import('vega-embed'),
    import('vega'),
  ]);

  return { loader, vegaEmbed };
}
