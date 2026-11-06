/**
 * Move to Agor Cloud copy (design source of truth). Names the design shows as
 * examples ("Ada", "Notion") are `{placeholders}`; fill them with `fill`.
 */
export const PACK_COPY = {
  menuExport: 'Export to file…',

  tmLabel: 'Teammates',
  histTitle: 'Session history',
  hist90: 'Last 90 days',
  histAll: 'All',
  histNone: 'None',
  histNoneD: 'Start fresh',
  histNote: 'Moved sessions are read-only. Continue any of them in a new session.',
  chooseTotal: '{n} {teammates}, about {mb} MB',

  checkTitle: 'Check before moving',
  grpMoves: 'Moves to Agor Cloud',
  movesPlus: 'Plus each teammate’s memory and skills.',
  grpReconnect: 'Reconnect after the move',
  reconnectWhy:
    'Passwords, API keys and sign-ins stay on Community Edition. Each person reconnects their own.',
  rcClaude: 'Claude account',
  grpWont: 'Won’t work in Agor Cloud yet',
  wontDocker: '{name} runs app previews on your server with Docker. Agor Cloud can’t do this yet.',
  wontDockerLink: 'See other ways to run previews',
  wontHost: '{name} uses {host}, which only works on your network. Agor Cloud can’t reach it.',
  wontHostLink: 'See options',
  grpLook: 'May contain passwords',
  lookKeys: '{n} sessions may contain a password or API key.',
  lookShow: 'Show sessions',
  lookToggle: 'Leave these {n} out',
  checkFoot: 'Your teammates keep running on Community Edition until you switch over.',

  progMoving: 'Moving',
  progWaiting: 'Waiting',
  progDone: 'Done',
  progRetry: 'Retry',

  expTitle: 'Export {name} to a file',
  expMove: 'Move {name}',
  expMoveD: 'Memory, skills, board, artifacts, knowledge, schedules and session history.',
  expSecrets: 'Passwords, API keys and sign-ins are never included.',
  expReconnect: 'Reconnect them after you import.',
  expBtn: 'Download',
  expToast: '{file} downloaded',

  impNav: 'Import',
  impHead: 'Import teammates',
  impLead: 'Bring in teammates exported from Community Edition or another workspace.',
  impLeadCe: 'Bring in teammates exported from Agor Cloud or another Community Edition.',
  impDrop: 'Drop an .agor file here, or browse',
  impDropSub: '.agor files up to 2 GB',
  impRemove: 'Remove',
  impCheck: 'Check before importing',
  impStart: 'Import {name}',
  grpImports: 'What’s imported',
  grpReconnectImp: 'Reconnect after import',
  reconnectWhyImp: 'Passwords, API keys and sign-ins aren’t in the file.',
  impOff: 'After you switch over, pause {name}’s schedules on Community Edition.',
  impProgress: 'Importing',
  impClose: 'You can close this window. The import keeps going.',

  fsTitle: 'Finish setup',
  fsLead: 'Reconnect your accounts so {name}’s schedules can run.',
  fsCount: '{n} of {total} reconnected',
  fsCountShort: '{n} of {total}',
  fsOpen: 'Finish setup',
  fsClaude: 'Claude account',
  fsClaudeUse: '{name} can’t reply without it. Set up in your Agor Cloud account.',
  fsUsedBy: 'Used by the {schedule} schedule',
  fsConnect: 'Reconnect',
  fsSave: 'Save',
  fsConnected: 'Connected',
  fsSecure: 'Saved securely. It won’t be shown again.',
  fsSlackHead: 'Needs a Slack admin',
  fsSlackNeeds: 'A Slack admin needs to approve it',
  fsAdmin: 'Admin',
  fsSchedHead: 'Schedules',
  fsAllDone: 'All {total} apps are reconnected. Switch over when you’re ready.',

  tagImported: 'Imported',
  schedPaused: 'Paused until you switch over',
  schedWaits: 'Waiting for {app}',
  impBar: 'This session is read-only. Continue it in a new session.',
  impLine: 'Imported from Community Edition on {date}',

  cancel: 'Cancel',
  back: 'Back',

  cntTeammate: 'teammate',
  cntTeammates: 'teammates',
  cntBoard: 'board',
  cntBoards: 'boards',
  cntArtifacts: 'artifacts',
  cntDocs: 'knowledge docs',
  cntSchedules: 'schedules',
  cntSessions: 'sessions',
} as const;

/** `fill('Move {name}', { name: 'Ada' })` → "Move Ada". */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}

/** "1 teammate" / "3 teammates" in the design's count labels. */
export function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** "about 120 MB" (at least 1). */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}
