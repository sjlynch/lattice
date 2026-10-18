import { useState } from 'react';
import { Folder, Merge, Plus, Scissors, Trash2 } from 'lucide-react';
import type { WorkflowStep } from '../../api';
import { areaPathMatches, sourceAreaLabel, type SourceTree } from '../../../../backend/src/shared/sourceAreas';
import { useSourceAreaPreview } from './hooks/useSourceAreaPreview';
import { mergeArea, renameArea, splitArea, canSplitArea, customAreaCounts, folderFileCount, folderAreaOwners, type CustomArea } from './splitAreas';

type SplitConfig = NonNullable<WorkflowStep['split']>;
export function SplitPanel({ project, identity, split, onChange }: {
  project: string; identity: symbol; split: SplitConfig; onChange: (split: WorkflowStep['split']) => void;
}) {
  const { preview, tree, treeError } = useSourceAreaPreview(project, identity, split);
  const [picking, setPicking] = useState(false);
  const areas = split.areas ?? [];
  const resolved = preview?.custom?.areas ?? [];
  const resolvedCustom = split.includeRest !== false && (preview?.custom?.rest ?? 0) > 0 ? resolved.slice(0, -1) : resolved;
  const counts = customAreaCounts(areas, resolvedCustom, tree);
  const custom = (next: CustomArea[]) => onChange({ mode: 'custom', areas: next, includeRest: split.includeRest !== false });
  return <section className="workflows-split-panel" aria-label="Step split areas" onDragStart={(e) => e.stopPropagation()}>
    <div className="workflows-split-controls">
      <label>Mode <select aria-label="Split mode" value={split.mode} onChange={(e) => {
        setPicking(false);
        onChange(e.target.value === 'auto' ? { mode: 'auto', count: 10 } : { mode: 'custom', areas: [], includeRest: true });
      }}><option value="auto">Automatic</option><option value="custom">Custom</option></select></label>
      {split.mode === 'auto' && <label>Areas <select aria-label="Area count" value={split.count ?? 10} onChange={(e) => onChange({ ...split, count: Number(e.target.value) })}>
        {[...new Set([4, 6, 8, 10, 12, 16, split.count ?? 10])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}{n === 10 ? ' · suggested' : ''}</option>)}
      </select></label>}
      <button type="button" className="btn-ghost" onClick={() => onChange(undefined)}>Remove split</button>
    </div>
    {split.mode === 'auto' ? <>
      <p>Areas are worked out again when the run starts, so they follow the repository.</p>
      {preview && <ul>{preview.areas.map((a, i) => <li key={i}>{a.label} <span>{a.files} files</span></li>)}</ul>}
      <button type="button" className="btn-ghost" disabled={!preview?.areas.length} onClick={() => custom(preview!.areas.map((a) => ({ label: a.label, paths: [...a.paths] })))}>Pin and edit</button>
    </> : <>
      <ul className="workflows-split-areas">{areas.map((area, i) => <li key={i}>
        <div className="workflows-split-controls">
          <input aria-label={`Area ${i + 1} label`} value={area.label} maxLength={80} onChange={(e) => custom(renameArea(areas, i, e.target.value))} />
          <span>{counts[i]} files</span>
          <button type="button" className="icon-btn sm" title="Merge with next area" aria-label={`Merge area ${i + 1} with next`} disabled={i === areas.length - 1} onClick={() => custom(mergeArea(areas, i))}><Merge size={13} /></button>
          <button type="button" className="icon-btn sm" title="Split area into two" aria-label={`Split area ${i + 1} into two`} disabled={areas.length >= 16 || !canSplitArea(area, tree)} onClick={() => custom(splitArea(areas, i, tree))}><Scissors size={13} /></button>
          <button type="button" className="icon-btn sm" title="Remove area" aria-label={`Remove area ${i + 1}`} onClick={() => custom(areas.filter((_, k) => k !== i))}><Trash2 size={13} /></button>
        </div>
        <small>{area.paths.join(', ')}</small>
        {preview?.custom?.missing.filter((p) => area.paths.includes(p)).map((p) => <p role="status" className="workflows-split-warning" key={p}>Missing path: {p}</p>)}
        {preview?.custom?.overlaps.filter((o) => o.areas.includes(area.label)).length ? <p role="status" className="workflows-split-warning">Overlapping files belong to the first listed area.</p> : null}
      </li>)}</ul>
      <label><input type="checkbox" checked={split.includeRest !== false} onChange={(e) => onChange({ ...split, includeRest: e.target.checked })} /> Include everything else</label>
      <p aria-live="polite">{split.includeRest !== false ? `Everything else: ${preview?.custom?.rest ?? '…'} files` : `${preview?.custom?.rest ?? '…'} files not in any area`}</p>
      <button type="button" className="btn-ghost" disabled={areas.length >= 16} onClick={() => setPicking(!picking)}><Plus size={12} /> Add area</button>
      {picking && <>
        {tree ? <FolderPicker tree={tree} areas={areas} onCancel={() => setPicking(false)} onAdd={(paths) => {
          custom([...areas, { label: sourceAreaLabel(paths), paths }]); setPicking(false);
        }} /> : <p>{treeError ?? 'Loading folders…'}</p>}
      </>}
    </>}
    {!preview && <p role="status">Checking areas…</p>}
    {preview?.error && <p role="status" className="workflows-split-warning">{preview.error}</p>}
  </section>;
}

function FolderPicker({ tree, areas, onAdd, onCancel }: { tree: SourceTree; areas: CustomArea[]; onAdd: (paths: string[]) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const branch = (node: SourceTree) => {
    const owners = folderAreaOwners(node.path, areas);
    const owner = owners.length === 1 ? owners[0].label : owners.length ? `in ${owners.length} areas` : null;
    const ancestorSelected = selected.some((p) => p !== node.path && areaPathMatches(p, node.path));
    return <li key={node.path}>
      <div className="workflows-split-folder">
        <label><input type="checkbox" checked={selected.includes(node.path) || ancestorSelected} disabled={!!owner || ancestorSelected}
          onChange={(e) => setSelected(e.target.checked ? [...selected.filter((p) => !areaPathMatches(node.path, p)), node.path] : selected.filter((p) => p !== node.path))} />
          <Folder size={13} /> {node.name} <span>{folderFileCount(node)} files{owner ? ` · ${owner}` : ''}</span></label>
      </div>
      {node.children.length > 0 && <details open={node.path === '.'}><summary>Folders in {node.name}</summary><ul>{node.children.map(branch)}</ul></details>}
    </li>;
  };
  return <div className="workflows-split-picker" role="group" aria-label="Choose folders">
    <ul>{branch(tree)}</ul>
    <div className="workflows-split-controls"><button type="button" className="btn-primary" disabled={!selected.length} onClick={() => onAdd(selected)}>Add selected folders as one area</button>
      <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button></div>
  </div>;
}
