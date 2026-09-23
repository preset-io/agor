/** Wire shape returned only after the daemon commits the managed Task holder. */
export interface ManagedOpenCodeNativeStateManifest {
  version: 3;
  attemptTaskId: string;
  storeId: string;
  digest: string;
  bytes: number;
  openCodeSessionId: string;
  openCodeVersion: string;
  publishedAt: string;
}

export interface ManagedOpenCodeAttemptGrant {
  task_id: string;
  store_id: string;
  holder_instance_id: string;
  input_store_id: string | null;
  input_task_id: string | null;
  input_read_closed_at: string | null;
  write_state: 'open' | 'sealed' | 'abandoned';
  sealed_manifest: ManagedOpenCodeNativeStateManifest | null;
  retired_at: string | null;
}

export interface ManagedOpenCodeAdmission {
  outcome: 'admitted';
  attempt: ManagedOpenCodeAttemptGrant;
  input: ManagedOpenCodeNativeStateManifest | null;
}
