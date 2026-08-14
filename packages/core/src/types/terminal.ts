import type { BranchID, UserID } from './id';

/** Trusted terminal identity assigned before executor startup events can arrive. */
export interface TerminalAllocatedEvent {
  userId: UserID;
  terminalId: string;
  branchId: BranchID;
}
