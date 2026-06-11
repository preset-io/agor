export function getModelDisplayName(modelId: string): string {
  if (modelId.includes('sonnet')) {
    const match = modelId.match(/sonnet-(\d)-(\d)/);
    return match ? `sonnet-${match[1]}.${match[2]}` : 'sonnet';
  }
  if (modelId.includes('haiku')) {
    const match = modelId.match(/haiku-(\d)-(\d)/);
    return match ? `haiku-${match[1]}.${match[2]}` : 'haiku';
  }
  if (modelId.includes('opus')) {
    const match = modelId.match(/opus-(\d)-(\d)/);
    return match ? `opus-${match[1]}.${match[2]}` : 'opus';
  }

  return modelId;
}
