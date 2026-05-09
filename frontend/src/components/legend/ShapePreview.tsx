import type { ExtStyle, Shape } from '../../extensionStyles';

// Inline SVG preview matching the canvas-drawn shapes in ForceGraphView.
// Two-color uses a linearGradient with hard 50% stops for the diagonal split.
export function ShapePreview({
  style,
  size = 14,
}: {
  style: ExtStyle;
  size?: number;
}) {
  const fillId = `lg-${style.shape}-${sanitize(style.color1)}-${sanitize(
    style.color2 ?? '',
  )}`;
  const fill = style.color2 ? `url(#${fillId})` : style.color1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {style.color2 && (
        <defs>
          <linearGradient
            id={fillId}
            x1="0"
            y1="0"
            x2="100%"
            y2="100%"
          >
            <stop offset="50%" stopColor={style.color2} />
            <stop offset="50%" stopColor={style.color1} />
          </linearGradient>
        </defs>
      )}
      <ShapeSvg shape={style.shape} fill={fill} />
    </svg>
  );
}

function ShapeSvg({ shape, fill }: { shape: Shape; fill: string }) {
  const stroke = 'rgba(0,0,0,0.45)';
  const strokeWidth = 0.6;
  switch (shape) {
    case 'circle':
      return (
        <circle cx={8} cy={8} r={6.6} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
      );
    case 'square':
      return (
        <rect
          x={1.6}
          y={1.6}
          width={12.8}
          height={12.8}
          rx={2.2}
          ry={2.2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'diamond':
      return (
        <polygon
          points="8,1 15,8 8,15 1,8"
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'hexagon': {
      // pointy-top hex
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const x = 8 + 6.6 * Math.cos(a);
        const y = 8 + 6.6 * Math.sin(a);
        pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      return (
        <polygon
          points={pts.join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'triangle': {
      const pts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        const x = 8 + 6.8 * Math.cos(a);
        const y = 8 + 6.5 * Math.sin(a);
        pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      return (
        <polygon
          points={pts.join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '');
}
