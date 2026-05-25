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
  { id: 'pan',        icon: Hand,          label: 'Pan',          shortcut: '' },
  { id: 'select',     icon: MousePointer2, label: 'Select',       shortcut: '1' },
  { id: 'pen',        icon: Pen,           label: 'Pen',          shortcut: '2' },
  { id: 'rect',       icon: Square,        label: 'Rectangle',    shortcut: '3' },
  { id: 'ellipse',    icon: Circle,        label: 'Ellipse',      shortcut: '4' },
  { id: 'arrow',      icon: ArrowUpRight,  label: 'Arrow',        shortcut: '5' },
  { id: 'line',       icon: Minus,         label: 'Line',         shortcut: '6' },
  { id: 'text',       icon: Type,          label: 'Text',         shortcut: '7' },
  { id: 'imageFrame', icon: Image,         label: 'Image',        shortcut: '8' },
  { id: 'frame',      icon: Frame,         label: 'Frame',        shortcut: '9' },
  { id: 'eraser',     icon: Eraser,        label: 'Eraser',       shortcut: '0' },
  { id: 'siteFrame',  icon: Globe,         label: 'Site Preview', shortcut: '' },
];

export default function LeftToolbar() {
  const { tool, setTool, penMode, setPenMode, keepToolActive, setKeepToolActive } = useCanvasStore();

  return (
    <div
      style={{
        width: 64,
        height: '100%',
        background: 'var(--theme-toolbar-bg)',
        borderRight: '1px solid var(--theme-toolbar-border)',
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
            title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
            onClick={() => setTool(t.id)}
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: 'none',
              background: active ? '#6366f1' : 'transparent',
              color: active ? '#fff' : 'var(--theme-icon-idle)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              transition: 'background 0.12s, color 0.12s',
              outline: 'none',
              position: 'relative',
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--theme-icon-hover-bg)';
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <Icon size={16} strokeWidth={1.8} />
            {t.shortcut && (
              <span style={{
                fontSize: 9,
                lineHeight: 1,
                opacity: active ? 0.8 : 0.45,
                fontFamily: 'monospace',
                letterSpacing: 0,
              }}>
                {t.shortcut}
              </span>
            )}
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
          background: penMode ? '#6366f1' : 'transparent',
          color: penMode ? '#fff' : 'var(--theme-icon-idle)',
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
          background: keepToolActive ? '#6366f1' : 'transparent',
          color: keepToolActive ? '#fff' : 'var(--theme-icon-idle)',
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
