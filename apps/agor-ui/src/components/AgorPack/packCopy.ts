/**
 * Move to Agor Cloud copy (design source of truth). Names the design shows as
 * examples ("Ada", "Notion") are `{placeholders}`; fill them with `fill`.
 */
export const PACK_COPY = {
  cloudNav: 'Agor Cloud',
  cloudTitle: 'Move to Agor Cloud',
  cloudLead: 'Agor Cloud runs your teammates for you.',
  cloudP1: 'Teammates keep working when your computer is off',
  cloudP2: 'Nothing to install or update',
  cloudP3: 'Invite your team to the same workspace',
  cloudComes: 'Teammates move with their boards, knowledge and session history.',
  cloudBtn: 'Move to Agor Cloud',
  cloudSafe: 'Your teammates keep running on Community Edition until you switch over.',

  menuMove: 'Move {name} to Agor Cloud…',
  menuExport: 'Export to file…',

  moveTitle: 'Move to Agor Cloud',
  steps: 'Sign in · Choose · Check · Move',
  signTitle: 'Sign in to Agor Cloud',
  signLead: 'Agor Cloud opens in your browser. Sign in there and it sends you back here.',
  signBtn: 'Open sign-in page',
  signWait: 'Finish signing in on the Agor Cloud tab in your browser.',
  signReopen: 'Open the sign-in page again',
  signedAs: 'Signed in as {email}',
  signSwitch: 'Use another account',
  pickWs: 'Workspace',
  wsCreate: 'Create a workspace',
  wsCreateD: 'For a team that isn’t in Agor Cloud yet',
  continue: 'Continue',

  chooseTitle: 'Choose what to move',
  tmAll: 'All teammates',
  tmAllD: '{names}, with their memory, skills, boards, artifacts, knowledge and schedules',
  tmPick: 'Choose teammates',

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
  tooLarge: '{n} attachments are too large to move (over 256 MB) and will be left out.',
  tooLargeOne: '1 attachment is too large to move (over 256 MB) and will be left out.',
  grpLook: 'May contain passwords',
  lookKeys: '{n} sessions may contain a password or API key.',
  lookShow: 'Show sessions',
  lookToggle: 'Leave these {n} out',
  checkFoot: 'Your teammates keep running on Community Edition until you switch over.',
  startBtn: 'Move {n} teammates',
  startBtnOne: 'Move {name}',

  progTitle: 'Moving your teammates',
  progClose: 'You can close this window. Keep your server on until the move is done.',
  progToRetry: '{n} to retry',
  progMoving: 'Moving',
  progWaiting: 'Waiting',
  progDone: 'Done',
  progRetry: 'Retry',
  doneTitle: '{names} {are} ready in Agor Cloud',
  doneSub: '{they} {keep} running on Community Edition until you switch over.',
  doneNext: 'Next, reconnect your accounts in Agor Cloud, then switch over.',
  doneOpen: 'Open Agor Cloud',
  doneClose: 'Close',

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
  fsLeadNoSchedules: 'Reconnect your accounts so {name} can work.',
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

/** "Ada", "Ada and Wendy", "Ada, Wendy and Blake". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "1 teammate" / "3 teammates" in the design's count labels. */
export function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** "about 120 MB" (at least 1). */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}
