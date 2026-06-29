import type { Response } from 'express';

// Small HTTP response shells shared by scratch-backed one-off run routes.
// They keep the idempotent "unknown id => {ok:true}" behavior and the
// frontend-acknowledgement DELETE shape centralized without hiding the
// route-specific work (QA verdict backstop, push event semantics, post-merge
// status/error handling) inside a large abstraction.

export async function finishHomeScratchDoneResponse<Run>(args: {
  res: Response;
  run: Run | null | undefined;
  onRun: (run: Run) => void | Promise<void>;
}): Promise<void> {
  if (args.run) await args.onRun(args.run);
  args.res.json({ ok: true });
}

export function deleteHomeScratchRunResponse(args: {
  res: Response;
  id: string;
  forget: (id: string) => void;
}): void {
  args.forget(args.id);
  args.res.json({ ok: true });
}
