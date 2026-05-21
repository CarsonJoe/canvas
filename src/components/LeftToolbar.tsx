import { useCanvasStore } from '../store/useCanvasStore';
import { ToolType } from '../types/canvas';
import {
  MousePointer2,
  Hand,
  Pen,
  Eraser,
  Square,
  Circle,
  Minus,
  ArrowUpRight,
  Type,
  Frame,
  Image,
  Globe,
  PenTool,
  Pin,
} from 'lucide-react';

interface ToolDef {
  id: ToolType;
  icon: React.ElementType;
  label: string;
  shortcut: string;
}

const TOOLS: ToolDef[] = [
  { id: 'select',  icon: MousePointer2, label: 'Select',    shortcut: 'V' },
  { id: 'pan',     icon: Hand,          label: 'Pan',        shortcut: 'H' },
  { id: 'pen',     icon: Pen,           label: 'Pen',        shortcut: 'P' },
  { id: 'eraser',  icon: Eraser,        label: 'Eraser',     shortcut: 'E' },
  { id: 'rect',    icon: Square,        label: 'Rectangle',  shortcut: 'R' },
  { id: 'ellipse', icon: Circle,        label: 'Ellipse',    shortcut: 'O' },
  { id: 'line',    icon: Minus,         label: 'Line',       shortcut: 'L' },
  { id: 'arrow',   icon: ArrowUpRight,  label: 'Arrow',      shortcut: 'A' },
  { id: 'text',    icon: Type,          label: 'Text',       shortcut: 'T' },
  { id: 'frame',      icon: Frame,          label: 'Frame',       shortcut: 'F' },
  { id: 'imageFrame', icon: Image,          label: 'Image',       shortcut: 'I' },
  { id: 'siteFrame',  icon: Globe,          label: 'Site Preview', shortcut: 'U' },
];

export default function LeftToolbar() {
  const { tool, setTool, penMode, setPenMode, keepToolActive, setKeepToolActive } = useCanvasStore();

  return (
    <div
      style={{
        width: 64,
        height: '100%',
        background: '#1a1a1a',
        borderRight: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 12,
        gap: 2,
        userSelect: 'none',
        zIndex: 10,
      }}
    >

      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = tool === t.id;

        return (
          <button
            key={t.id}
            title={`${t.label} (${t.shortcut})`}
            onClick={() => setTool(t.id)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: 'none',
              background: active ? '#6366f1' : 'transparent',
              color: active ? '#fff' : '#888',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.12s, color 0.12s',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = '#2a2a2a';
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <Icon size={18} strokeWidth={1.8} />
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <button
        title={penMode ? 'Pen mode on: stylus draws, fingers navigate' : 'Pen mode off: one finger draws, two fingers navigate'}
        aria-pressed={penMode}
        onClick={() => setPenMode(!penMode)}
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          border: 'none',
          background: penMode ? '#3b3f8f' : 'transparent',
          color: penMode ? '#fff' : '#888',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
        }}
      >
        <PenTool size={18} strokeWidth={1.8} />
      </button>

      <button
        title={keepToolActive ? 'Keep tool active: on' : 'Keep tool active: off (switches to select after drawing)'}
        aria-pressed={keepToolActive}
        onClick={() => setKeepToolActive(!keepToolActive)}
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          border: 'none',
          background: keepToolActive ? '#3b3f8f' : 'transparent',
          color: keepToolActive ? '#fff' : '#888',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
        }}
      >
        <Pin size={18} strokeWidth={1.8} />
      </button>
    </div>
  );
}
