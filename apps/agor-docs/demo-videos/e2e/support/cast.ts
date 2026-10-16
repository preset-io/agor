// The people in our videos. Fictional teammates at the Donut Shop (the demo
// project), each a real Agor account the workspace seed creates, so their
// names, initials, and live cursors look like a real team on camera.
//
// `sam` is the workspace's first admin: the development default admin the
// daemon bootstraps (its email and password are fixed by the dev bootstrap),
// renamed by the seed. Everyone else is a member.
//
// Passwords only need to pass the daemon's policy (15+ characters, not
// common); they never appear on screen.

import { ADMIN_USER } from './harness.ts';

export interface CastMember {
  name: string;
  email: string;
  password: string;
  role: 'superadmin' | 'admin' | 'member';
}

export const CAST = {
  sam: { name: 'Sam Rivera', ...ADMIN_USER, role: 'superadmin' },
  ada: {
    name: 'Ada Okafor',
    email: 'ada@agor.live',
    password: 'sprinkles-and-glaze-42',
    role: 'member',
  },
  grace: {
    name: 'Grace Liu',
    email: 'grace@agor.live',
    password: 'cruller-at-midnight-17',
    role: 'member',
  },
  kai: {
    name: 'Kai Moreno',
    email: 'kai@agor.live',
    password: 'maple-bar-orbit-2048',
    role: 'member',
  },
} as const satisfies Record<string, CastMember>;

export type CastKey = keyof typeof CAST;
export const CAST_KEYS = Object.keys(CAST) as CastKey[];
