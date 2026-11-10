// SaaSy Co.'s open work, for the "Multiply engineering throughput" section:
// GitHub issues on saasy-co/app and Jira tickets in the SAASY project, so
// "find 5 issues to work on" has two real-looking backlogs to pull from.
// Each one is small and real against fixtures/repos/saasy-app, so an agent
// can actually fix it.

import type { FakeIssue, FakeTicket } from '../fixtures.ts';

export const GITHUB_ISSUES: FakeIssue[] = [
  {
    number: 322,
    title: 'Invoice total ignores per-line discounts',
    author: 'grace-saasyco',
    ageDays: 21,
    labels: ['bug', 'billing'],
    comments: 3,
    body: 'Lines carry `discountPct` since the pricing change, but `invoiceTotalCents` (src/billing/invoice.ts) still sums qty × unit price. Customers on promo pricing get overbilled. Round each discounted line to the cent before summing.',
  },
  {
    number: 327,
    title: 'Technician app silently drops updates past the offline queue cap',
    author: 'kai-saasyco',
    ageDays: 16,
    labels: ['bug', 'mobile'],
    comments: 5,
    body: 'When a tech is offline long enough to queue more than MAX_QUEUED_UPDATES (src/mobile/sync.ts), the oldest updates are discarded with no warning. Keep status changes (job started/completed) over location pings when trimming, and expose how many were dropped.',
  },
  {
    number: 331,
    title: 'Skill matching is case-sensitive ("HVAC" vs "hvac")',
    author: 'ada-saasyco',
    ageDays: 9,
    labels: ['bug', 'scheduling', 'good first issue'],
    comments: 1,
    body: '`assign()` in src/scheduling/assign.ts compares skills exactly, so a job needing "HVAC" never matches a tech with "hvac". Normalize case (and trim) on both sides.',
  },
  {
    number: 334,
    title: 'Dark mode for the dispatcher calendar',
    author: 'kai-saasyco',
    ageDays: 30,
    labels: ['enhancement', 'design'],
    comments: 12,
    body: 'Dispatchers on night shifts keep asking. Needs design first.',
  },
  {
    number: 338,
    title: 'Document the QuickBooks sync retry policy',
    author: 'sam-saasyco',
    ageDays: 4,
    labels: ['docs'],
    assignees: ['grace-saasyco'],
    body: 'Follow-up to #315: write down attempts, backoff and jitter in the README.',
  },
];

export const JIRA_PEOPLE: Record<string, string> = {
  'sam@saasy.co': 'Sam Rivera',
  'ada@saasy.co': 'Ada Okafor',
  'grace@saasy.co': 'Grace Liu',
  'kai@saasy.co': 'Kai Moreno',
};

export const JIRA_TICKETS: FakeTicket[] = [
  {
    key: 'SAASY-431',
    summary: 'Late fee applied to invoices paid on the due date',
    type: 'Bug',
    status: 'To Do',
    priority: 'High',
    assignee: 'grace@saasy.co',
    reporter: 'sam@saasy.co',
    ageDays: 12,
    labels: ['billing', 'customer-reported'],
    description:
      'Payments recorded any time on the due date should count as on time. Today the check compares against midnight at the start of the due date, so a 2pm payment gets a late fee. Three customers have written in this week.',
  },
  {
    key: 'SAASY-436',
    summary: 'Assign the least-booked qualified technician, not the first',
    type: 'Story',
    status: 'To Do',
    priority: 'Medium',
    assignee: 'ada@saasy.co',
    reporter: 'ada@saasy.co',
    ageDays: 8,
    labels: ['scheduling'],
    description:
      'assign() returns the first free tech with the skills, so the same techs get every job. Among qualified, free techs, pick the one free soonest (earliest bookedUntil); ties keep list order.',
  },
  {
    key: 'SAASY-440',
    summary: 'Reject jobs whose time window ends before it starts',
    type: 'Bug',
    status: 'To Do',
    priority: 'High',
    reporter: 'kai@saasy.co',
    ageDays: 5,
    labels: ['scheduling', 'validation'],
    description:
      'The booking form lets a dispatcher save a window with end before start, and assign() happily books it. Validate in assign() and return a clear error instead of a technician.',
  },
  {
    key: 'SAASY-442',
    summary: 'Customer portal: download all invoices as one PDF',
    type: 'Story',
    status: 'To Do',
    priority: 'Low',
    reporter: 'sam@saasy.co',
    ageDays: 26,
    labels: ['portal'],
    description: 'Needs a PDF service decision first.',
  },
  {
    key: 'SAASY-445',
    summary: 'Round invoice tax per line, not on the total',
    type: 'Task',
    status: 'To Do',
    priority: 'Medium',
    assignee: 'sam@saasy.co',
    reporter: 'grace@saasy.co',
    ageDays: 3,
    labels: ['billing'],
    description:
      'Matches how QuickBooks rounds, so synced invoices stop being off by a cent. Add a taxPct per line and round each line tax half-up to the cent.',
  },
  {
    key: 'SAASY-447',
    summary: 'Upgrade the mobile build to the new SDK',
    type: 'Task',
    status: 'In Progress',
    priority: 'Medium',
    assignee: 'kai@saasy.co',
    reporter: 'kai@saasy.co',
    ageDays: 2,
    labels: ['mobile'],
  },
];
