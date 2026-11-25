import { loadFont } from '@remotion/google-fonts/HankenGrotesk';

// agor.live's type: Hanken Grotesk, thin (100) for heading body, 600 for the
// gradient accent word, 700 for the strong word.
export const { fontFamily } = loadFont('normal', {
  weights: ['100', '300', '500', '600', '700'],
});
