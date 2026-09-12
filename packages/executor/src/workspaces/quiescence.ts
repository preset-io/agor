/** Docker requires PID in custom `top` output to filter the container's tasks. */
export const SDK_PROCESS_COLUMNS = 'pid,ppid,comm';
export function isQuiescentSdkTree(exitCode: number, output: string): boolean {
  if (exitCode !== 0) return false;
  const rows = output
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
  if (
    rows.length !== 2 ||
    rows.some((row) => row.length !== 3 || !/^\d+$/.test(row[0]) || !/^\d+$/.test(row[1]))
  )
    return false;
  const init = rows.find((row) => row[2] === 'docker-init');
  const node = rows.find((row) => row[2] === 'node');
  return !!init && !!node && node[1] === init[0] && node[0] !== init[0];
}
