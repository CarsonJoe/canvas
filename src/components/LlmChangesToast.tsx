import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../store/useCanvasStore';

const DISMISS_MS = 30_000;

export default function LlmChangesToast() {
  const count = useCanvasStore((s) => s.pendingLlmChangeCount);
  const clear = useCanvasStore((s) => s.clearPendingLlmChanges);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (count === 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      clear();
      timerRef.current = null;
    }, DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [count, clear]);

  if (count === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      bottom: 48,
      right: 16,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 14px',
      borderRadius: 8,
      background: 'var(--theme-menu-bg)',
      border: '1px solid var(--theme-menu-border)',
      backdropFilter: 'blur(8px)',
      color: 'var(--theme-text)',
      fontSize: 13,
      fontFamily: 'inherit',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      userSelect: 'none',
      pointerEvents: 'all',
    }}>
      <span style={{ opacity: 0.6, fontSize: 15 }}>✦</span>
      <span>{count} new {count === 1 ? 'change' : 'changes'} from Claude</span>
      <button
        onClick={clear}
        style={{
          marginLeft: 4,
          background: 'none',
          border: 'none',
          color: 'var(--theme-text-muted)',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: '0 2px',
          fontFamily: 'inherit',
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
