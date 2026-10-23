import { fileURLToPath } from 'node:url';
const font = name => fileURLToPath(new URL(`./vendor/office/${name}`, import.meta.url));
/** Droid fallback covers CJK, not ASCII; select a licensed Latin font per text run. */
export function documentPdfFonts() {
  const cjk = font('DroidSansFallbackFull.ttf');
  return {
    CJK: { normal: cjk, bold: cjk, italics: cjk, bolditalics: cjk },
    Latin: { normal: font('DejaVuSans.ttf'), bold: font('DejaVuSans-Bold.ttf'),
      italics: font('DejaVuSans-Oblique.ttf'), bolditalics: font('DejaVuSans-BoldOblique.ttf') },
  };
}
const CJK = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]+)/u;
export function pdfFontRuns(text) {
  return String(text).split(CJK).filter(Boolean).map(text => ({ text, font: CJK.test(text) ? 'CJK' : 'Latin' }));
}
