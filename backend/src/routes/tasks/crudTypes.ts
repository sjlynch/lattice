import type { Request } from 'express';

// Shared across the CRUD handler modules: routes parameterized by task id.
export type TaskIdRequest = Request<{ id: string }>;
