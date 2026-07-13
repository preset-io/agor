// biome-ignore-all lint/plugin/noHardcodedColorLiteral: exact favicon pixels are the regression-test contract
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { getFaviconStatusColors } from './useFaviconStatus';

describe('getFaviconStatusColors', () => {
  it('retains absolute black/white contrast under AntD darkAlgorithm', () => {
    const token = theme.getDesignToken({ algorithm: theme.darkAlgorithm });

    expect(getFaviconStatusColors(token.colorSuccessText)).toEqual({
      running: '#ffffff',
      ready: token.colorSuccessText,
      border: '#000000',
    });
  });
});
