import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../store/useCanvasStore';
import { CanvasDocument } from '../types/canvas';

const POLL_MS = 900;

function isLocalServer(): boolean {
  return window.location.hostname === '127.0.0.1'
    || window.location.hostname === 'localhost';
}

async function fetchDocument(): Promise<CanvasDocument | null> {
  const response = await fetch('/api/document', { cache: 'no-store' });
  if (!response.ok) return null;
  return response.json();
}

async function postDocument(document: CanvasDocument): Promise<void> {
  await fetch('/api/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document),
  });
}

async function fetchWorkingIds(): Promise<string[]> {
  const response = await fetch('/api/working', { cache: 'no-store' });
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body.ids) ? body.ids : [];
}

interface ScreenshotRequest {
  id: string;
  target?: Parameters<NonNullable<ReturnType<typeof useCanvasStore.getState>['captureScreenshot']>>[0];
  scale?: number;
}

async function fetchScreenshotRequest(): Promise<ScreenshotRequest | null> {
  const response = await fetch('/api/screenshot-request', { cache: 'no-store' });
  if (!response.ok) return null;
  const body = await response.json();
  return body.request && typeof body.request.id === 'string' ? body.request : null;
}

async function postScreenshotResponse(responseBody: {
  id: string;
  imageData?: string;
  error?: string;
  capturedAt: string;
}): Promise<void> {
  await fetch('/api/screenshot-response', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseBody),
  });
}

export default function LocalDocumentBridge() {
  const importDocument = useCanvasStore((state) => state.importDocument);
  const markWorking = useCanvasStore((state) => state.markWorking);
  const finishWorking = useCanvasStore((state) => state.finishWorking);
  const lastRemoteUpdatedAtRef = useRef<string | null>(null);
  const lastPostedUpdatedAtRef = useRef<string | null>(null);
  const lastScreenshotRequestIdRef = useRef<string | null>(null);
  const applyingRemoteRef = useRef(false);

  useEffect(() => {
    if (!isLocalServer()) return;
    let cancelled = false;

    fetchDocument()
      .then((document) => {
        if (!document || cancelled) return;
        applyingRemoteRef.current = true;
        importDocument(document);
        lastRemoteUpdatedAtRef.current = document.updatedAt;
        lastPostedUpdatedAtRef.current = document.updatedAt;
        window.setTimeout(() => { applyingRemoteRef.current = false; }, 0);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [importDocument]);

  useEffect(() => {
    if (!isLocalServer()) return;
    const interval = window.setInterval(() => {
      fetchWorkingIds()
        .then((ids) => {
          finishWorking();
          if (ids.length > 0) markWorking(ids);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [finishWorking, markWorking]);

  useEffect(() => {
    if (!isLocalServer()) return;
    const interval = window.setInterval(() => {
      fetchScreenshotRequest()
        .then(async (request) => {
          if (!request || request.id === lastScreenshotRequestIdRef.current) return;
          const captureScreenshot = useCanvasStore.getState().captureScreenshot;
          if (!captureScreenshot) return;
          lastScreenshotRequestIdRef.current = request.id;
          try {
            const imageData = await captureScreenshot(request.target, request.scale ?? 1);
            await postScreenshotResponse({
              id: request.id,
              imageData,
              capturedAt: new Date().toISOString(),
            });
          } catch (error) {
            await postScreenshotResponse({
              id: request.id,
              error: error instanceof Error ? error.message : 'Screenshot capture failed',
              capturedAt: new Date().toISOString(),
            });
          }
        })
        .catch(() => {});
    }, 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isLocalServer()) return;
    const unsubscribe = useCanvasStore.subscribe((state) => {
      if (applyingRemoteRef.current) return;
      const document = state.exportDocument();
      if (document.updatedAt === lastPostedUpdatedAtRef.current) return;
      lastPostedUpdatedAtRef.current = document.updatedAt;
      postDocument(document).catch(() => {});
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isLocalServer()) return;
    const interval = window.setInterval(() => {
      fetchDocument()
        .then((document) => {
          if (!document) return;
          const local = useCanvasStore.getState();
          if (document.updatedAt === lastRemoteUpdatedAtRef.current) {
            lastRemoteUpdatedAtRef.current = document.updatedAt;
            return;
          }
          if (document.updatedAt === local.updatedAt || document.updatedAt === lastPostedUpdatedAtRef.current) {
            lastRemoteUpdatedAtRef.current = document.updatedAt;
            return;
          }
          applyingRemoteRef.current = true;
          importDocument(document);
          lastRemoteUpdatedAtRef.current = document.updatedAt;
          lastPostedUpdatedAtRef.current = document.updatedAt;
          window.setTimeout(() => { applyingRemoteRef.current = false; }, 0);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [importDocument]);

  return null;
}
