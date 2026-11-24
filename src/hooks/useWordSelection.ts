/*
 * Adapted from Rescript v1.0.9 (MIT),
 * https://github.com/wassgha/rescript/blob/fb71f82/hooks/useTranscriptSelection.ts
 * Copyright (c) 2026 Rescript contributors. See THIRD_PARTY_NOTICES.md.
 *
 * Changes from upstream: selection state is local instead of in a zustand
 * store; the timeline-mirroring effect and the "correcting" freeze are
 * removed (no timeline yet; Fix spelling is Phase 5); word ids are our
 * numeric `idx`; seeking goes through an `onSeekWord` callback; the
 * toolbar sits below the selection when there's no room above it in the
 * window, and is kept inside the container horizontally.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface WordSelectionInfo {
  /** Selected words' `idx`, in document order. */
  ids: number[];
  anyRemoved: boolean;
  anyKept: boolean;
  /** Toolbar position, relative to the container. */
  top: number;
  left: number;
}

/** While dragging: paint marks only. On mouseup / keyboard: sync to React. */
type SelectionSyncMode = "paint" | "commit";

const TOOLBAR_OFFSET_PX = 44;
/** Half the toolbar's width, roughly: it's centred on `left`. */
const TOOLBAR_HALF_WIDTH_PX = 100;

function toolbarPosition(
  rangeRect: DOMRect,
  containerRect: DOMRect,
): Pick<WordSelectionInfo, "top" | "left"> {
  // Above the selection, unless that would be off the top of the window.
  const roomAbove = rangeRect.top >= TOOLBAR_OFFSET_PX;
  const centre = rangeRect.left - containerRect.left + rangeRect.width / 2;
  return {
    top: roomAbove
      ? rangeRect.top - containerRect.top - TOOLBAR_OFFSET_PX
      : rangeRect.bottom - containerRect.top + 8,
    left: Math.min(
      Math.max(TOOLBAR_HALF_WIDTH_PX, centre),
      Math.max(TOOLBAR_HALF_WIDTH_PX, containerRect.width - TOOLBAR_HALF_WIDTH_PX),
    ),
  };
}

/** Walk up from a Range boundary to the nearest word span inside `container`. */
function wordElFromNode(node: Node | null, container: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== container) {
    if (n instanceof HTMLElement && n.dataset.wid != null) return n;
    n = n.parentNode;
  }
  return null;
}

function wordElsInRange(container: HTMLElement, range: Range): HTMLElement[] {
  const all = container.querySelectorAll<HTMLElement>("[data-wid]");
  if (all.length === 0) return [];

  const startEl = wordElFromNode(range.startContainer, container);
  const endEl = wordElFromNode(range.endContainer, container);

  if (startEl && endEl) {
    // Contiguous span between Range endpoints — cheaper than intersectsNode
    // on every word (the hot path during drag).
    const out: HTMLElement[] = [];
    let marking = false;
    for (const el of all) {
      const atBoundary = el === startEl || el === endEl;
      if (atBoundary) {
        out.push(el);
        if (startEl === endEl) break;
        if (marking) break;
        marking = true;
      } else if (marking) {
        out.push(el);
      }
    }
    return out;
  }

  // Fallback when a boundary isn't inside a word span.
  return Array.from(all).filter((el) => range.intersectsNode(el));
}

function selectionInfoFromWordEls(
  els: HTMLElement[],
  range: Range,
  container: HTMLElement,
  removedIds: Set<number>,
): WordSelectionInfo | null {
  if (els.length === 0) return null;

  const ids: number[] = [];
  let anyRemoved = false;
  let anyKept = false;
  for (const el of els) {
    const id = Number(el.dataset.wid);
    ids.push(id);
    if (removedIds.has(id)) anyRemoved = true;
    else anyKept = true;
  }

  return {
    ids,
    anyRemoved,
    anyKept,
    ...toolbarPosition(range.getBoundingClientRect(), container.getBoundingClientRect()),
  };
}

/**
 * Transcript text selection: imperative `data-sel` marks while dragging,
 * React state sync on mouseup (or immediately for keyboard selection).
 */
export function useWordSelection({
  containerRef,
  removedIds,
  onSeekWord,
}: {
  containerRef: RefObject<HTMLElement | null>;
  removedIds: Set<number>;
  onSeekWord: (idx: number) => void;
}) {
  const [selection, setSelection] = useState<WordSelectionInfo | null>(null);

  const markedRef = useRef<Set<HTMLElement>>(new Set());
  // Single-word click has no native range; collapsed selectionchange must not wipe it.
  const clickSelectionRef = useRef(false);
  // Between mousedown and mouseup, selectionchange only paints marks.
  const mouseDownRef = useRef(false);
  // Mirrored into refs so the event handlers below stay stable across edits.
  const removedIdsRef = useRef(removedIds);
  removedIdsRef.current = removedIds;
  const onSeekWordRef = useRef(onSeekWord);
  onSeekWordRef.current = onSeekWord;

  const clearMarks = useCallback(() => {
    for (const el of markedRef.current) el.removeAttribute("data-sel");
    markedRef.current.clear();
  }, []);

  const applyMarks = useCallback((els: HTMLElement[]) => {
    const marked = new Set<HTMLElement>();
    for (const el of els) {
      el.setAttribute("data-sel", "");
      marked.add(el);
    }
    for (const el of markedRef.current) {
      if (!marked.has(el)) el.removeAttribute("data-sel");
    }
    markedRef.current = marked;
  }, []);

  const clearSelection = useCallback(() => {
    clearMarks();
    clickSelectionRef.current = false;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [clearMarks]);

  const handleWordClick = useCallback(
    (idx: number, el: HTMLElement) => {
      const nativeSel = window.getSelection();
      // Drag ends with a click on the word under the cursor — leave the range alone.
      if (nativeSel && !nativeSel.isCollapsed) return;
      onSeekWordRef.current(idx);
      const container = containerRef.current;
      if (!container) return;
      applyMarks([el]);
      clickSelectionRef.current = true;
      const removed = removedIdsRef.current.has(idx);
      setSelection({
        ids: [idx],
        anyRemoved: removed,
        anyKept: !removed,
        ...toolbarPosition(el.getBoundingClientRect(), container.getBoundingClientRect()),
      });
    },
    [applyMarks, containerRef],
  );

  // Paint marks on selectionchange; commit to React only when the mouse is up.
  useEffect(() => {
    const clearEmptySelection = () => {
      if (clickSelectionRef.current) return;
      clearMarks();
      setSelection(null);
    };

    const updateFromNativeSelection = (mode: SelectionSyncMode) => {
      const container = containerRef.current;
      const sel = window.getSelection();

      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearEmptySelection();
        return;
      }

      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clearEmptySelection();
        return;
      }

      clickSelectionRef.current = false;
      const els = wordElsInRange(container, range);
      applyMarks(els);

      if (mode === "paint") {
        // Hide a stale toolbar while dragging; marks stay imperative.
        setSelection(null);
        return;
      }
      setSelection(selectionInfoFromWordEls(els, range, container, removedIdsRef.current));
    };

    const onSelectionChange = () => {
      updateFromNativeSelection(mouseDownRef.current ? "paint" : "commit");
    };

    const onMouseDown = () => {
      mouseDownRef.current = true;
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;
      mouseDownRef.current = false;

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        updateFromNativeSelection("commit");
        return;
      }

      // Collapsed: mouseup on a word is owned by the click handler.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-wid]")) return;
      if (clickSelectionRef.current) return;
      clearMarks();
      setSelection(null);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      if (!clickSelectionRef.current) clearMarks();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [clearMarks, applyMarks, containerRef]);

  // Clear a click-selection when mousedown lands outside words/toolbar.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!clickSelectionRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-wid], [data-transcript-toolbar]")) return;
      clearSelection();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [clearSelection]);

  return { selection, clearSelection, handleWordClick };
}
