import { useEffect, useRef } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { Box, CircularProgress, Typography } from '@mui/material';
import type { ScanResult, GraphNode } from '../api';

type Props = {
  data: ScanResult | null;
  loading: boolean;
};

const EXT_COLORS: Record<string, string> = {
  '.ts': '#3178c6',
  '.tsx': '#3178c6',
  '.js': '#f7df1e',
  '.jsx': '#f7df1e',
  '.mjs': '#f7df1e',
  '.cjs': '#f7df1e',
  '.py': '#3572A5',
  '.go': '#00ADD8',
  '.rs': '#dea584',
  '.java': '#b07219',
  '.kt': '#A97BFF',
  '.c': '#555555',
  '.cpp': '#f34b7d',
  '.cc': '#f34b7d',
  '.h': '#888888',
  '.hpp': '#888888',
  '.cs': '#178600',
  '.rb': '#701516',
  '.php': '#4F5D95',
  '.swift': '#F05138',
  '.dart': '#00B4AB',
  '.vue': '#41b883',
  '.svelte': '#ff3e00',
  '.css': '#563d7c',
  '.scss': '#c6538c',
  '.sass': '#c6538c',
  '.less': '#1d365d',
  '.html': '#e34c26',
  '.json': '#cbcb41',
  '.yaml': '#cb171e',
  '.yml': '#cb171e',
  '.toml': '#9c4221',
  '.md': '#bbbbbb',
  '.sh': '#89e051',
  '.sql': '#dad8d8',
};

const DIR_COLOR = '#ffd54f';

function colorFor(node: GraphNode): string {
  if (node.kind === 'dir') return DIR_COLOR;
  return (node.ext && EXT_COLORS[node.ext]) || '#9aa0a6';
}

function sizeFor(node: GraphNode): number {
  if (node.kind === 'dir') return 6;
  const kb = (node.size ?? 0) / 1024;
  return Math.min(8, 2 + Math.log2(1 + kb));
}

export function ForceGraphView({ data, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const graph = new ForceGraph3D(containerRef.current)
      .backgroundColor('#08090b')
      .nodeId('id')
      .nodeLabel((n) => {
        const node = n as GraphNode;
        return `${node.kind === 'dir' ? '📁 ' : ''}${node.name}`;
      })
      .nodeColor((n) => colorFor(n as GraphNode))
      .nodeVal((n) => sizeFor(n as GraphNode))
      .linkColor(() => 'rgba(255,255,255,0.18)')
      .linkOpacity(0.4)
      .linkWidth(0.4)
      .showNavInfo(false);

    graphRef.current = graph;

    const onResize = () => {
      if (!containerRef.current) return;
      graph.width(containerRef.current.clientWidth);
      graph.height(containerRef.current.clientHeight);
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      graph._destructor?.();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!graphRef.current) return;
    if (data) {
      graphRef.current.graphData({
        nodes: data.nodes.map((n) => ({ ...n })),
        links: data.links.map((l) => ({ ...l })),
      });
    } else {
      graphRef.current.graphData({ nodes: [], links: [] });
    }
  }, [data]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            bgcolor: 'rgba(0,0,0,0.6)',
            color: '#fff',
            px: 1.5,
            py: 0.75,
            borderRadius: 1,
          }}
        >
          <CircularProgress size={16} />
          <Typography variant="caption">Scanning…</Typography>
        </Box>
      )}
      {!loading && data && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            bgcolor: 'rgba(0,0,0,0.6)',
            color: '#fff',
            px: 1.5,
            py: 0.5,
            borderRadius: 1,
          }}
        >
          <Typography variant="caption">
            {data.nodes.filter((n) => n.kind === 'file').length} files ·{' '}
            {data.nodes.filter((n) => n.kind === 'dir').length} dirs
          </Typography>
        </Box>
      )}
    </Box>
  );
}
