import { Check, Minus } from 'lucide-react';
import styles from '../LandingPage.module.css';

type Cell = true | false | string;

// Mirrors the branch-role table on /security. A string cell is a conditional yes.
const ROWS: Array<{ capability: string; viewer: Cell; collaborator: Cell; manager: Cell }> = [
  {
    capability: 'See the branch and its sessions',
    viewer: true,
    collaborator: true,
    manager: true,
  },
  {
    capability: 'Start and prompt their own sessions',
    viewer: false,
    collaborator: true,
    manager: true,
  },
  {
    capability: 'Open the branch terminal',
    viewer: false,
    collaborator: 'With file access',
    manager: 'With file access',
  },
  {
    capability: 'Prompt a colleague’s session',
    viewer: false,
    collaborator: 'If enabled',
    manager: 'If enabled',
  },
  {
    capability: 'Run environments and session lifecycle',
    viewer: false,
    collaborator: false,
    manager: true,
  },
  {
    capability: 'Manage the branch and its permissions',
    viewer: false,
    collaborator: false,
    manager: true,
  },
];

function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <span className={styles.roleYes}>
        <Check size={16} aria-hidden />
        <span className={styles.srOnly}>Yes</span>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className={styles.roleNo}>
        <Minus size={16} aria-hidden />
        <span className={styles.srOnly}>No</span>
      </span>
    );
  }
  return <span className={styles.roleMaybe}>{value}</span>;
}

/** Branch roles at a glance, for the /governance permissions block. */
export function RoleMatrix() {
  return (
    <div className={styles.roleMatrix}>
      <table>
        <caption>Branch roles in Agor</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className={styles.srOnly}>Capability</span>
            </th>
            <th scope="col">Viewer</th>
            <th scope="col">Collaborator</th>
            <th scope="col">Manager</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.capability}>
              <th scope="row">{row.capability}</th>
              <td>
                <CellValue value={row.viewer} />
              </td>
              <td>
                <CellValue value={row.collaborator} />
              </td>
              <td>
                <CellValue value={row.manager} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.roleFootnote}>
        Grant roles to people, groups, or everyone else in the workspace. Manager never implies
        access to someone else’s sessions or credentials.
      </p>
    </div>
  );
}
