export type LockBody = {
  pid: number;
  hostname: string;
  startedAt: number;
  label: string;
};

export type ProjectRunLockInspection = {
  holder: LockBody;
  alive: boolean;
};

export type ProjectRunLockHandle = {
  release: () => Promise<void>;
};
