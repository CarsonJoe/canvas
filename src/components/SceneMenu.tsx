import { useEffect, useRef, useState } from "react";
import { Cable, Download, KeyRound, Menu, Upload } from "lucide-react";
import { CanvasScene, useCanvasStore } from "../store/useCanvasStore";
import { CanvasDocument } from "../types/canvas";
import {
  clearOpenAiApiKey,
  getOpenAiApiKey,
  hasOpenAiApiKey,
  listenForOpenAiApiKeyChanges,
  listenForOpenAiApiKeyRequests,
  setOpenAiApiKey,
} from "../services/openaiKey";

function isScene(value: unknown): value is CanvasScene {
  if (!value || typeof value !== "object") return false;
  const scene = value as Partial<CanvasScene>;
  return Array.isArray(scene.objects);
}

function normalizeScene(value: unknown): CanvasScene {
  const raw = Array.isArray(value) ? { objects: value } : value;
  if (!isScene(raw)) {
    throw new Error("Choose a valid canvas scene JSON file.");
  }

  return {
    version: 1,
    exportedAt:
      typeof raw.exportedAt === "string"
        ? raw.exportedAt
        : new Date().toISOString(),
    objects: raw.objects,
    selectedIds: Array.isArray(raw.selectedIds) ? raw.selectedIds : [],
    stageX: typeof raw.stageX === "number" ? raw.stageX : 0,
    stageY: typeof raw.stageY === "number" ? raw.stageY : 0,
    stageScale: typeof raw.stageScale === "number" ? raw.stageScale : 1,
    frameCount: typeof raw.frameCount === "number" ? raw.frameCount : 0,
    brushColor: typeof raw.brushColor === "string" ? raw.brushColor : "#1a1a1a",
    brushSize: typeof raw.brushSize === "number" ? raw.brushSize : 6,
    brushOpacity: typeof raw.brushOpacity === "number" ? raw.brushOpacity : 1,
    pressureSize:
      typeof raw.pressureSize === "boolean" ? raw.pressureSize : true,
    pressureOpacity:
      typeof raw.pressureOpacity === "boolean" ? raw.pressureOpacity : false,
    pressureMin: typeof raw.pressureMin === "number" ? raw.pressureMin : 0.25,
    shapeType:
      raw.shapeType === "ellipse" || raw.shapeType === "line"
        ? raw.shapeType
        : "rect",
    fillColor:
      typeof raw.fillColor === "string" ? raw.fillColor : "transparent",
    shapeStrokeColor:
      typeof raw.shapeStrokeColor === "string"
        ? raw.shapeStrokeColor
        : "#1a1a1a",
    shapeStrokeWidth:
      typeof raw.shapeStrokeWidth === "number" ? raw.shapeStrokeWidth : 2,
    fontSize: typeof raw.fontSize === "number" ? raw.fontSize : 24,
    fontColor: typeof raw.fontColor === "string" ? raw.fontColor : "#1a1a1a",
  };
}

function isDocument(value: unknown): value is CanvasDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CanvasDocument>;
  return (
    document.version === 1 &&
    typeof document.id === "string" &&
    Array.isArray(document.objects)
  );
}

function normalizeDocument(value: unknown): CanvasDocument | null {
  if (!isDocument(value)) return null;
  return {
    version: 1,
    id: value.id,
    name: typeof value.name === "string" ? value.name : "Untitled canvas",
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString(),
    objects: value.objects,
    selectedIds: Array.isArray(value.selectedIds) ? value.selectedIds : [],
    viewport: {
      x: typeof value.viewport?.x === "number" ? value.viewport.x : 0,
      y: typeof value.viewport?.y === "number" ? value.viewport.y : 0,
      scale:
        typeof value.viewport?.scale === "number" ? value.viewport.scale : 1,
    },
  };
}

function sceneFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `canvas-${stamp}.canvas.json`;
}

const menuButtonStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 10,
  border: "1px solid var(--theme-menu-border)",
  background: "var(--theme-menu-bg)",
  color: "var(--theme-text)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const actionStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  color: "var(--theme-text-dim)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 10px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

export default function SceneMenu() {
  const [open, setOpen] = useState(false);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(() => hasOpenAiApiKey());
  const [status, setStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exportDocument = useCanvasStore((s) => s.exportDocument);
  const importScene = useCanvasStore((s) => s.importScene);
  const importDocument = useCanvasStore((s) => s.importDocument);

  useEffect(() => {
    if (!open && !keyDialogOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setKeyDialogOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, keyDialogOpen]);

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(""), 2400);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    return listenForOpenAiApiKeyChanges(() =>
      setApiKeySaved(hasOpenAiApiKey())
    );
  }, []);

  useEffect(() => {
    return listenForOpenAiApiKeyRequests(() => {
      setApiKeyDraft(getOpenAiApiKey());
      setKeyDialogOpen(true);
      setOpen(false);
    });
  }, []);

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(exportDocument(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sceneFileName();
    link.click();
    URL.revokeObjectURL(url);
    setOpen(false);
    setStatus("Document exported");
  };

  const handleConnectMcp = () => {
    window.open(
      `${import.meta.env.BASE_URL}cogniboom-canvas/setup.html`,
      "_blank",
      "noopener,noreferrer"
    );
    setOpen(false);
  };

  const openKeyDialog = () => {
    setApiKeyDraft(getOpenAiApiKey());
    setKeyDialogOpen(true);
    setOpen(false);
  };

  const saveKey = () => {
    setOpenAiApiKey(apiKeyDraft);
    setKeyDialogOpen(false);
    setStatus(
      apiKeyDraft.trim() ? "OpenAI key saved locally" : "OpenAI key removed"
    );
  };

  const removeKey = () => {
    clearOpenAiApiKey();
    setApiKeyDraft("");
    setKeyDialogOpen(false);
    setStatus("OpenAI key removed");
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const document = normalizeDocument(parsed);
      if (document) {
        importDocument(document);
      } else {
        importScene(normalizeScene(parsed));
      }
      setStatus("Document imported");
      setOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        zIndex: 40,
      }}
    >
      <button
        title="Scene menu"
        aria-label="Scene menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={menuButtonStyle}
      >
        <Menu size={18} strokeWidth={1.8} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 46,
            right: 0,
            width: 184,
            padding: 6,
            borderRadius: 12,
            border: "1px solid var(--theme-menu-border)",
            background: "var(--theme-menu-bg)",
            boxShadow: "0 16px 44px rgba(0,0,0,0.55)",
            backdropFilter: "blur(16px)",
          }}
        >
          <button
            type="button"
            onClick={handleExport}
            style={actionStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--theme-menu-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Download size={15} />
            Export document
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={actionStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--theme-menu-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Upload size={15} />
            Import document
          </button>
          <button
            type="button"
            onClick={handleConnectMcp}
            style={actionStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--theme-menu-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Cable size={15} />
            Connect MCP
          </button>
          <button
            type="button"
            onClick={openKeyDialog}
            style={actionStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--theme-menu-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <KeyRound size={15} />
            {apiKeySaved ? "OpenAI key set" : "Set OpenAI key"}
          </button>
        </div>
      )}

      {keyDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="OpenAI API key"
          style={{
            position: "absolute",
            top: 46,
            right: 0,
            width: 340,
            padding: 14,
            borderRadius: 12,
            border: "1px solid var(--theme-menu-border)",
            background: "var(--theme-menu-bg)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.25)",
            color: "var(--theme-text)",
            backdropFilter: "blur(16px)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            OpenAI API key
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--theme-text-muted)",
              lineHeight: 1.4,
              marginBottom: 12,
            }}
          >
            Stored only in this browser. It is not saved in canvas documents or
            sent to Cogniboom.
          </div>
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder="OpenAI API key"
            autoFocus
            style={{
              width: "100%",
              height: 34,
              borderRadius: 8,
              border: "1px solid var(--theme-input-border)",
              background: "var(--theme-input-bg)",
              color: "var(--theme-text)",
              padding: "0 10px",
              outline: "none",
              fontSize: 13,
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveKey();
              if (e.key === "Escape") setKeyDialogOpen(false);
            }}
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 12,
            }}
          >
            {apiKeySaved && (
              <button
                type="button"
                onClick={removeKey}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#fca5a5",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "7px 8px",
                }}
              >
                Remove
              </button>
            )}
            <button
              type="button"
              onClick={() => setKeyDialogOpen(false)}
              style={{
                border: "1px solid var(--theme-input-border)",
                background: "var(--theme-surface)",
                color: "var(--theme-text-dim)",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12,
                padding: "7px 10px",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveKey}
              style={{
                border: "none",
                background: "#0f766e",
                color: "#fff",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                padding: "7px 10px",
              }}
            >
              Save key
            </button>
          </div>
        </div>
      )}

      {status && (
        <div
          style={{
            position: "absolute",
            top: 48,
            right: 0,
            minWidth: 160,
            maxWidth: 260,
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid var(--theme-menu-border)",
            background: "var(--theme-menu-bg)",
            color:
              status.includes("valid") || status.includes("failed")
                ? "#ef4444"
                : "var(--theme-accent-text)",
            fontSize: 12,
            lineHeight: 1.35,
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          }}
        >
          {status}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => handleImport(e.target.files?.[0])}
      />
    </div>
  );
}
