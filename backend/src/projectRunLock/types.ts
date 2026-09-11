export type LockBody = {
  pid: number;
  hostname: string;
  startedAt: number;
  label: string;
  // Unique generation identity; older locks did not include this field.
  ownerId?: string;
};

export type ProjectRunLockInspection = {
  holder: LockBody;
  alive: boolean;
};

export type ProjectRunLockHandle = {
  release: () => Promise<void>;
};
