import { GITHUB_REPO_URL } from '../lib/links';

/** First year agor.live was published; the range runs to the build year. */
const FIRST_YEAR = 2025;
const year = Number(process.env.AGOR_BUILD_YEAR) || FIRST_YEAR;
const years = year > FIRST_YEAR ? `${FIRST_YEAR}–${year}` : String(FIRST_YEAR);

/**
 * The legal fine print every footer ends with (landing pages, /cloud, docs):
 * copyright, trademarks, the Community Edition license, and the third-party
 * disclaimer. Text only; each footer supplies its own wrapper and styling.
 */
export function FinePrint() {
  return (
    <>
      © {years} Preset, Inc. Agor and Agor Cloud are trademarks of Preset, Inc. Agor Community
      Edition is source-available under the{' '}
      <a href={`${GITHUB_REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
        Business Source License 1.1
      </a>
      . Agor is not affiliated with or endorsed by the companies mentioned on this site; all other
      product names, logos, and brands are property of their respective owners.
    </>
  );
}
