// Railway's published image contains dependencies/runtime tooling, not branch
// application source. Keep ordinary application PRs out of its Docker checks.
export function isRailwayImageInput(filename) {
  return (
    /^(docker\/|patches\/|scripts\/managed-environments\/railway\/)/.test(filename) ||
    /^(apps|packages)\/[^/]+\/package\.json$/.test(filename) ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.dockerignore',
      '.agor.yml',
      '.github/workflows/build-image.yml',
      'scripts/check-image-publication-policy.mjs',
      'scripts/railway-image-inputs.mjs',
      'scripts/railway-image-inputs.test.mjs',
    ].includes(filename)
  );
}

export async function shouldBuildRailwayImage({ github, context }) {
  // Preserve main, tag, and manual validation/publication behavior.
  if (context.eventName !== 'pull_request') return true;
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: context.payload.pull_request.number,
    per_page: 100,
  });
  // GitHub caps this endpoint at 3,000 files. Don't silently skip checks when
  // the inventory may be incomplete; API errors also fail the workflow.
  return (
    files.length >= 3000 ||
    files.some(
      (file) =>
        isRailwayImageInput(file.filename) ||
        (file.previous_filename && isRailwayImageInput(file.previous_filename))
    )
  );
}
