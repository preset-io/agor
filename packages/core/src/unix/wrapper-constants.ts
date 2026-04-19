/**
 * Shared constants for the privileged-operations wrapper.
 *
 * The wrapper at this absolute path replaces the wildcard NOPASSWD sudoers
 * rules that previously exposed useradd/userdel/usermod/gpasswd/groupadd/
 * groupdel/chpasswd/find directly to the daemon. All Node-side callers that
 * shell out to it must reference this constant rather than hard-coding the
 * path so the location stays in lockstep with `docker/sudoers/agor-user-admin`
 * and the sudoers rule.
 *
 * @see docker/sudoers/agor-user-admin
 * @see docker/sudoers/agor-daemon.sudoers
 */
export const AGOR_USER_ADMIN = '/usr/local/sbin/agor-user-admin';
