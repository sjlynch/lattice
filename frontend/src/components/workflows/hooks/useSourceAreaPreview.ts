import { useEffect, useMemo, useState } from 'react';
import { fetchSourceAreas, fetchSourceTree, resolveSourceAreas, type WorkflowStep } from '../../../api';
import type { CustomAreasResult, SourceArea, SourceTree } from '../../../../../backend/src/shared/sourceAreas';

type Preview = { areas: SourceArea[]; custom?: CustomAreasResult; error?: string };
export function useSourceAreaPreview(project: string, identity: symbol, split: NonNullable<WorkflowStep['split']>) {
  // A new token on every lifetime / configuration change also hides old results
  // during render, before effect cleanup can cancel an older request.
  const token = useMemo(() => Symbol(), [project, identity, split]);
  const treeToken = useMemo(() => Symbol(), [project, identity]);
  const [result, setResult] = useState<{ token: symbol; value: Preview }>();
  const [treeResult, setTreeResult] = useState<{ token: symbol; tree?: SourceTree; error?: string }>();
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const timer = setTimeout(() => {
      const request = split.mode === 'auto'
        ? fetchSourceAreas(project, split.count ?? 10, controller.signal).then((v) => ({ areas: v.areas }))
        : resolveSourceAreas(project, split.areas ?? [], split.includeRest !== false, controller.signal).then((v) => ({ areas: v.areas, custom: v }));
      void request.then((value) => { if (live) setResult({ token, value }); }, (err: Error) => {
        if (live) setResult({ token, value: { areas: [], error: `Couldn't preview areas: ${err.message}` } });
      });
    }, 150);
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [project, split, token]);
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    void fetchSourceTree(project, controller.signal).then((tree) => { if (live) setTreeResult({ token: treeToken, tree }); }, (err: Error) => {
      if (live) setTreeResult({ token: treeToken, error: `Couldn't load folders: ${err.message}` });
    });
    return () => { live = false; controller.abort(); };
  }, [project, treeToken]);
  return { preview: result?.token === token ? result.value : undefined,
    tree: treeResult?.token === treeToken ? treeResult.tree : undefined,
    treeError: treeResult?.token === treeToken ? treeResult.error : undefined };
}
