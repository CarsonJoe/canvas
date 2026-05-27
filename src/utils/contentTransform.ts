import { nanoid } from 'nanoid';
import { CanvasObject } from '../types/canvas';

const CONTENT_FRAME_WIDTH = 640;

// ─── Markdown → canvas objects ────────────────────────────────────────────────

export async function markdownToCanvasObjects(
  source: string,
  originX: number,
  originY: number,
  width = CONTENT_FRAME_WIDTH,
): Promise<CanvasObject[]> {
  const { marked } = await import('marked');
  const html = await marked.parse(source);
  return htmlBlocksToCanvasObjects(html, originX, originY, width);
}

// ─── HTML → canvas objects via DOM measurement ───────────────────────────────

export async function htmlToCanvasObjects(
  html: string,
  originX: number,
  originY: number,
  width = CONTENT_FRAME_WIDTH,
): Promise<CanvasObject[]> {
  return htmlBlocksToCanvasObjects(html, originX, originY, width);
}

function htmlBlocksToCanvasObjects(
  html: string,
  originX: number,
  originY: number,
  width: number,
): Promise<CanvasObject[]> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    container.style.cssText = `
      position:fixed; left:-99999px; top:0;
      width:${width}px; visibility:hidden; pointer-events:none;
      font-family:system-ui,-apple-system,sans-serif; font-size:16px;
      line-height:1.6; color:#fff;
    `;
    container.innerHTML = `<div>${html}</div>`;
    document.body.appendChild(container);

    requestAnimationFrame(() => {
      const objects: CanvasObject[] = [];
      const cRect = container.getBoundingClientRect();
      const inner = container.firstElementChild!;

      walkBlocks(inner, cRect, originX, originY, objects);

      document.body.removeChild(container);
      resolve(objects);
    });
  });
}

function walkBlocks(
  parent: Element,
  cRect: DOMRect,
  originX: number,
  originY: number,
  objects: CanvasObject[],
) {
  for (const el of Array.from(parent.children)) {
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const x = originX + (r.left - cRect.left);
    const y = originY + (r.top - cRect.top);
    const w = r.width;
    const h = r.height;
    if (w < 1 || h < 1) continue;

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]);
      const sizes = [32, 26, 22, 18, 16, 14];
      objects.push({
        id: nanoid(), type: 'text',
        x, y, width: w,
        text: el.textContent ?? '',
        fontSize: sizes[level - 1] ?? 16,
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });
    } else if (tag === 'p') {
      objects.push({
        id: nanoid(), type: 'text',
        x, y, width: w,
        text: el.textContent ?? '',
        fontSize: 16,
        color: '#cccccc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });
    } else if (tag === 'pre') {
      const pad = 12;
      objects.push({
        id: nanoid(), type: 'rect',
        x: x - pad, y: y - pad,
        width: w + pad * 2, height: h + pad * 2,
        fill: '#1a1a2e', stroke: '#333', strokeWidth: 1,
        opacity: 1, cornerRadius: 6,
      });
      objects.push({
        id: nanoid(), type: 'text',
        x, y, width: w,
        text: el.textContent ?? '',
        fontSize: 13,
        color: '#a9b7c6',
        fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
      });
    } else if (tag === 'blockquote') {
      const pad = 12;
      objects.push({
        id: nanoid(), type: 'rect',
        x: x - pad, y: y - pad,
        width: w + pad * 2, height: h + pad * 2,
        fill: 'transparent', stroke: '#6366f1', strokeWidth: 3,
        opacity: 0.8, cornerRadius: 4,
      });
      walkBlocks(el, cRect, originX, originY, objects);
    } else if (tag === 'hr') {
      objects.push({
        id: nanoid(), type: 'line',
        x1: x, y1: y + h / 2, x2: x + w, y2: y + h / 2,
        stroke: '#444', strokeWidth: 1, opacity: 1,
      });
    } else if (tag === 'ul' || tag === 'ol') {
      let i = 0;
      for (const li of Array.from(el.children)) {
        const lr = li.getBoundingClientRect();
        const lx = originX + (lr.left - cRect.left);
        const ly = originY + (lr.top - cRect.top);
        const prefix = tag === 'ul' ? '• ' : `${++i}. `;
        objects.push({
          id: nanoid(), type: 'text',
          x: lx, y: ly, width: lr.width,
          text: prefix + (li.textContent ?? ''),
          fontSize: 16,
          color: '#cccccc',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        });
      }
    } else if (tag === 'table') {
      objects.push({
        id: nanoid(), type: 'rect',
        x, y, width: w, height: h,
        fill: 'transparent', stroke: '#333', strokeWidth: 1,
        opacity: 1, cornerRadius: 4,
      });
      for (const row of Array.from(el.querySelectorAll('tr'))) {
        for (const cell of Array.from(row.querySelectorAll('th,td'))) {
          const cr = cell.getBoundingClientRect();
          objects.push({
            id: nanoid(), type: 'text',
            x: originX + (cr.left - cRect.left) + 8,
            y: originY + (cr.top - cRect.top) + 4,
            width: cr.width - 16,
            text: cell.textContent ?? '',
            fontSize: 14,
            color: cell.tagName.toLowerCase() === 'th' ? '#ffffff' : '#cccccc',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          });
        }
      }
    }
  }
}

// ─── Mermaid → canvas objects ─────────────────────────────────────────────────

export async function mermaidToCanvasObjects(
  source: string,
  originX: number,
  originY: number,
): Promise<CanvasObject[]> {
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

  const id = `mermaid-tmp-${nanoid()}`;
  const { svg } = await mermaid.render(id, source);
  return svgToCanvasObjects(svg, originX, originY);
}

// ─── SVG → canvas objects ─────────────────────────────────────────────────────

export function svgToCanvasObjects(
  svgString: string,
  originX: number,
  originY: number,
): CanvasObject[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;

  // Resolve viewBox scale
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const svgW = vb ? vb[2] : parseFloat(svg.getAttribute('width') ?? '400');
  const svgH = vb ? vb[3] : parseFloat(svg.getAttribute('height') ?? '300');
  const attrW = parseFloat(svg.getAttribute('width') ?? String(svgW));
  const attrH = parseFloat(svg.getAttribute('height') ?? String(svgH));
  const scaleX = svgW > 0 ? attrW / svgW : 1;
  const scaleY = svgH > 0 ? attrH / svgH : 1;

  const objects: CanvasObject[] = [];

  const toWorld = (svgX: number, svgY: number) => ({
    x: originX + svgX * scaleX,
    y: originY + svgY * scaleY,
  });

  svg.querySelectorAll('rect').forEach((el) => {
    const x = parseFloat(el.getAttribute('x') ?? '0');
    const y = parseFloat(el.getAttribute('y') ?? '0');
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    if (w < 1 || h < 1) return;
    const fill = resolveSvgColor(el.getAttribute('fill'), '#1e1e2e');
    const stroke = resolveSvgColor(el.getAttribute('stroke'), 'transparent');
    const pos = toWorld(x, y);
    objects.push({
      id: nanoid(), type: 'rect',
      x: pos.x, y: pos.y,
      width: w * scaleX, height: h * scaleY,
      fill, stroke,
      strokeWidth: parseFloat(el.getAttribute('stroke-width') ?? '1'),
      opacity: parseFloat(el.getAttribute('opacity') ?? '1'),
      cornerRadius: parseFloat(el.getAttribute('rx') ?? '0'),
    });
  });

  svg.querySelectorAll('circle').forEach((el) => {
    const cx = parseFloat(el.getAttribute('cx') ?? '0');
    const cy = parseFloat(el.getAttribute('cy') ?? '0');
    const r = parseFloat(el.getAttribute('r') ?? '0');
    if (r < 1) return;
    const pos = toWorld(cx, cy);
    objects.push({
      id: nanoid(), type: 'ellipse',
      x: pos.x, y: pos.y,
      radiusX: r * scaleX, radiusY: r * scaleY,
      fill: resolveSvgColor(el.getAttribute('fill'), '#1e1e2e'),
      stroke: resolveSvgColor(el.getAttribute('stroke'), 'transparent'),
      strokeWidth: parseFloat(el.getAttribute('stroke-width') ?? '1'),
      opacity: parseFloat(el.getAttribute('opacity') ?? '1'),
    });
  });

  svg.querySelectorAll('ellipse').forEach((el) => {
    const cx = parseFloat(el.getAttribute('cx') ?? '0');
    const cy = parseFloat(el.getAttribute('cy') ?? '0');
    const rx = parseFloat(el.getAttribute('rx') ?? '0');
    const ry = parseFloat(el.getAttribute('ry') ?? '0');
    if (rx < 1 || ry < 1) return;
    const pos = toWorld(cx, cy);
    objects.push({
      id: nanoid(), type: 'ellipse',
      x: pos.x, y: pos.y,
      radiusX: rx * scaleX, radiusY: ry * scaleY,
      fill: resolveSvgColor(el.getAttribute('fill'), '#1e1e2e'),
      stroke: resolveSvgColor(el.getAttribute('stroke'), 'transparent'),
      strokeWidth: parseFloat(el.getAttribute('stroke-width') ?? '1'),
      opacity: parseFloat(el.getAttribute('opacity') ?? '1'),
    });
  });

  svg.querySelectorAll('line').forEach((el) => {
    const p1 = toWorld(parseFloat(el.getAttribute('x1') ?? '0'), parseFloat(el.getAttribute('y1') ?? '0'));
    const p2 = toWorld(parseFloat(el.getAttribute('x2') ?? '0'), parseFloat(el.getAttribute('y2') ?? '0'));
    objects.push({
      id: nanoid(), type: 'line',
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      stroke: resolveSvgColor(el.getAttribute('stroke'), '#888'),
      strokeWidth: parseFloat(el.getAttribute('stroke-width') ?? '1'),
      opacity: parseFloat(el.getAttribute('opacity') ?? '1'),
    });
  });

  svg.querySelectorAll('text').forEach((el) => {
    const x = parseFloat(el.getAttribute('x') ?? '0');
    const y = parseFloat(el.getAttribute('y') ?? '0');
    const text = el.textContent?.trim() ?? '';
    if (!text) return;
    const fontSize = parseFloat(el.getAttribute('font-size') ?? el.style?.fontSize ?? '14');
    const pos = toWorld(x, y - fontSize);
    objects.push({
      id: nanoid(), type: 'text',
      x: pos.x, y: pos.y,
      text,
      fontSize: Math.max(8, fontSize),
      color: resolveSvgColor(el.getAttribute('fill') ?? el.getAttribute('color'), '#ffffff'),
      fontFamily: el.getAttribute('font-family') ?? 'system-ui, sans-serif',
    });
  });

  return objects;
}

function resolveSvgColor(value: string | null, fallback: string): string {
  if (!value || value === 'none' || value === 'transparent') return fallback;
  return value;
}
