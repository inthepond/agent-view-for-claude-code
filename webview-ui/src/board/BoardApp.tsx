import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary } from "../protocol";
import type {
  BoardArrow,
  BoardCamera,
  BoardCard,
  BoardDoc,
  BoardSelectionEntry,
  ExtToBoard,
  TeamSnapshot,
} from "./protocol";
import { post, vscode } from "./api";
import { Canvas, AgentNode } from "./Canvas";
import { Onboarding } from "./Onboarding";
import { TeamsCockpit } from "./TeamsCockpit";
import { Dot } from "../ui";
import { IconNote, IconLink, IconSend, IconTrash, IconHistory, IconReset, IconAgent, IconTeam, IconHelp } from "./icons";

const NEW_CARD_W = 260;

function uid(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const r = c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${r}`;
}

function selectionEntries(doc: BoardDoc, ids: string[]): BoardSelectionEntry[] {
  const out: BoardSelectionEntry[] = [];
  for (const id of ids) {
    const c = doc.cards.find((x) => x.id === id);
    if (!c) continue;
    out.push({
      cardId: c.id,
      kind: c.kind,
      title: c.title,
      body: c.body ? c.body.slice(0, 4000) : undefined,
      diffExcerpt: c.diffText ? c.diffText.split("\n").slice(0, 60).join("\n") : undefined,
      filePath: c.filePath,
      branch: c.branch,
      sourceSessionId: c.sourceSessionId,
    });
  }
  return out;
}

export function BoardApp() {
  const [fleet, setFleet] = useState<AgentSummary[]>([]);
  const [doc, setDoc] = useState<BoardDoc>({ version: 1, cards: [], arrows: [], updatedAt: 0 });
  const [camera, setCamera] = useState<BoardCamera>({ x: 40, y: 40, zoom: 1 });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [config, setConfig] = useState({ boardDir: ".agentview/board", hooksReady: false });
  const [showGuide, setShowGuide] = useState(false);
  const [sendMenu, setSendMenu] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [recency, setRecency] = useState({ showOlder: false, hiddenCount: 0 });
  const [teams, setTeams] = useState<TeamSnapshot | null>(null);
  const [mode, setMode] = useState<"canvas" | "teams">("canvas");
  const [pinHintSeen, setPinHintSeen] = useState(
    () => !!vscode.getState<{ pinHintSeen?: boolean }>()?.pinHintSeen,
  );

  const loadedRef = useRef(false);
  const skipSaveRef = useRef(false);
  const cameraRef = useRef(camera);
  const agentPos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const viewportSize = useRef({ w: 1000, h: 700 });
  const cascade = useRef(0);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  // First-run guide (bumped key so existing installs see the refreshed guide).
  useEffect(() => {
    const st = vscode.getState<{ guideSeenV2?: boolean }>();
    if (!st?.guideSeenV2) setShowGuide(true);
  }, []);

  const placeAndAddCard = (card: BoardCard) => {
    const { w: vw, h: vh } = viewportSize.current;
    const cam = cameraRef.current;
    const baseX = (vw / 2 - cam.x) / cam.zoom - NEW_CARD_W / 2;
    const baseY = (vh / 2 - cam.y) / cam.zoom - 60;
    const off = (cascade.current++ % 6) * 26;
    const placed: BoardCard = { ...card, x: card.x || baseX + off, y: card.y || baseY + off };
    setDoc((d) => ({
      ...d,
      cards: [...d.cards.filter((c) => c.id !== placed.id), placed],
      updatedAt: Date.now(),
    }));
  };

  // Incoming messages.
  useEffect(() => {
    const onMsg = (e: MessageEvent<ExtToBoard>) => {
      const m = e.data;
      if (m.type === "fleet") setFleet(m.agents);
      else if (m.type === "meta") setRecency({ showOlder: m.showOlder, hiddenCount: m.hiddenCount });
      else if (m.type === "teams") setTeams(m.snapshot);
      else if (m.type === "config") setConfig({ boardDir: m.boardDir, hooksReady: m.hooksReady });
      else if (m.type === "board") {
        skipSaveRef.current = true;
        setDoc(m.doc);
        if (m.doc.camera) setCamera(m.doc.camera);
        loadedRef.current = true;
      } else if (m.type === "addCard") {
        placeAndAddCard(m.card);
      }
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the board (debounced); skip the echo of a freshly-loaded doc.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      post({ type: "saveBoard", doc: { ...doc, camera, updatedAt: Date.now() } });
    }, 600);
    return () => clearTimeout(t);
  }, [doc, camera]);

  // Keep selection.json fresh.
  useEffect(() => {
    const t = setTimeout(() => {
      const entries = selectionEntries(doc, selectedIds);
      const arrows = doc.arrows
        .filter((a) => a.fromCard && a.toCard && selectedIds.includes(a.fromCard) && selectedIds.includes(a.toCard))
        .map((a) => ({
          from: doc.cards.find((c) => c.id === a.fromCard)?.title,
          to: doc.cards.find((c) => c.id === a.toCard)?.title,
          label: a.label,
        }));
      post({ type: "selection", entries, arrows });
    }, 250);
    return () => clearTimeout(t);
  }, [selectedIds, doc]);

  const sessions = useMemo(() => fleet.filter((a) => a.kind === "session"), [fleet]);
  const subsByParent = useMemo(() => {
    const m = new Map<string, AgentSummary[]>();
    for (const a of fleet) {
      if (a.kind === "subagent" && a.parentId) {
        const arr = m.get(a.parentId);
        if (arr) arr.push(a);
        else m.set(a.parentId, [a]);
      }
    }
    return m;
  }, [fleet]);

  const agentNodes: AgentNode[] = useMemo(() => {
    return sessions.map((a, i) => {
      let p = agentPos.current.get(a.sessionId);
      if (!p) {
        p = { x: 24, y: 24 + i * 168 };
        agentPos.current.set(a.sessionId, p);
      }
      return {
        sessionId: a.sessionId,
        x: p.x,
        y: p.y,
        agent: a,
        subCount: subsByParent.get(a.sessionId)?.length || 0,
        expanded: expandedAgents.has(a.sessionId),
        isSub: false,
      };
    });
  }, [sessions, subsByParent, expandedAgents]);

  const subNodes: AgentNode[] = useMemo(() => {
    const out: AgentNode[] = [];
    for (const s of sessions) {
      if (!expandedAgents.has(s.sessionId)) continue;
      const parent = agentPos.current.get(s.sessionId);
      subsByParent.get(s.sessionId)?.forEach((sub, i) => {
        let p = agentPos.current.get(sub.sessionId);
        if (!p) {
          p = { x: (parent?.x ?? 24) + 250, y: (parent?.y ?? 24) + i * 84 };
          agentPos.current.set(sub.sessionId, p);
        }
        out.push({ sessionId: sub.sessionId, x: p.x, y: p.y, agent: sub, subCount: 0, isSub: true });
      });
    }
    return out;
  }, [sessions, subsByParent, expandedAgents]);

  const tethers = useMemo(() => {
    const t: { from: string; to: string }[] = [];
    for (const s of sessions) {
      if (!expandedAgents.has(s.sessionId)) continue;
      for (const sub of subsByParent.get(s.sessionId) || []) t.push({ from: s.sessionId, to: sub.sessionId });
    }
    return t;
  }, [sessions, subsByParent, expandedAgents]);

  const allAgents = useMemo(() => [...agentNodes, ...subNodes], [agentNodes, subNodes]);

  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0 };
    for (const a of sessions) {
      if (a.status === "running") c.running++;
      else if (a.status === "waiting") c.waiting++;
    }
    return c;
  }, [sessions]);

  // --- mutations ---
  const moveCard = (id: string, x: number, y: number) =>
    setDoc((d) => ({ ...d, cards: d.cards.map((c) => (c.id === id ? { ...c, x, y } : c)), updatedAt: Date.now() }));
  const moveAgent = (sid: string, x: number, y: number) => {
    agentPos.current.set(sid, { x, y });
    setFleet((f) => [...f]); // nudge a re-render with new positions
  };
  const editBody = (id: string, body: string) => {
    setDoc((d) => ({ ...d, cards: d.cards.map((c) => (c.id === id ? { ...c, body } : c)), updatedAt: Date.now() }));
    setEditingId(null);
  };
  const addNote = () => {
    const card: BoardCard = {
      id: uid("note"),
      kind: "note",
      title: "Note",
      body: "",
      x: 0,
      y: 0,
      createdBy: "human",
      createdAt: Date.now(),
    };
    placeAndAddCard(card);
    setEditingId(card.id);
  };
  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    setDoc((d) => ({
      ...d,
      cards: d.cards.filter((c) => !selectedIds.includes(c.id)),
      arrows: d.arrows.filter(
        (a) => !(a.fromCard && selectedIds.includes(a.fromCard)) && !(a.toCard && selectedIds.includes(a.toCard)),
      ),
      updatedAt: Date.now(),
    }));
    setSelectedIds([]);
  };
  const linkSelected = () => {
    if (selectedIds.length !== 2) return;
    const arrow: BoardArrow = {
      id: uid("arw"),
      fromCard: selectedIds[0],
      toCard: selectedIds[1],
      label: "",
      createdAt: Date.now(),
    };
    setDoc((d) => ({ ...d, arrows: [...d.arrows, arrow], updatedAt: Date.now() }));
  };
  const setArrowLabel = (id: string, label: string) =>
    setDoc((d) => ({ ...d, arrows: d.arrows.map((a) => (a.id === id ? { ...a, label } : a)), updatedAt: Date.now() }));

  // Selecting a linked card selects its whole connected group (cards joined by arrows).
  const linkedGroup = (id: string): string[] => {
    const adj = new Map<string, Set<string>>();
    for (const a of doc.arrows) {
      if (!a.fromCard || !a.toCard) continue;
      (adj.get(a.fromCard) ?? adj.set(a.fromCard, new Set()).get(a.fromCard)!).add(a.toCard);
      (adj.get(a.toCard) ?? adj.set(a.toCard, new Set()).get(a.toCard)!).add(a.fromCard);
    }
    const comp: string[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      comp.push(n);
      for (const m of adj.get(n) ?? []) if (!seen.has(m)) stack.push(m);
    }
    return comp;
  };
  const selectCard = (id: string, additive: boolean) => {
    const group = linkedGroup(id);
    setSelectedIds((prev) => {
      if (!additive) return group;
      if (prev.includes(id)) return prev.filter((x) => !group.includes(x)); // toggle the group off
      return Array.from(new Set([...prev, ...group]));
    });
  };
  const clearSelection = () => {
    setSelectedIds([]);
    setSendMenu(false);
  };

  // --- agent actions ---
  const sendToAgent = (sid: string) => {
    post({ type: "selection", entries: selectionEntries(doc, selectedIds), arrows: [] });
    post({ type: "sendToAgent", sessionId: sid });
    setSendMenu(false);
  };

  // Background click just hides — it shouldn't permanently suppress the guide.
  const dismissGuide = () => setShowGuide(false);
  // Only the explicit "Got it" marks the guide as seen.
  const closeGuide = () => {
    setShowGuide(false);
    vscode.setState({ ...(vscode.getState<object>() || {}), guideSeenV2: true });
  };

  const toggleSubs = (id: string) =>
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const resetView = () => setCamera({ x: 40, y: 40, zoom: 1 });

  const empty = sessions.length === 0 && doc.cards.length === 0;

  return (
    <div className="board">
      {/* top-left status chip — canvas-only (the cockpit has its own header) */}
      {mode === "canvas" && (
        <div className="board-chip" role="status">
          <span className="board-chip-title">Pinboard</span>
          <span className="board-chip-counts">
            <span className="board-chip-pill run">{counts.running} running</span>
            <span className="board-chip-pill wait">{counts.waiting} waiting</span>
          </span>
        </div>
      )}

      {/* contextual selection bar — canvas-only; the cockpit is read-only */}
      {mode === "canvas" && selectedIds.length > 0 && (
        <div className="sel-bar" role="toolbar" aria-label="Selection actions">
          <span className="sel-count">{selectedIds.length} selected</span>
          <span className="sel-div" />
          {selectedIds.length === 2 && (
            <button className="dock-btn" onClick={linkSelected} title="Link the two selected cards with an arrow">
              <IconLink />
            </button>
          )}
          <div className="send-wrap">
            <button
              className="dock-btn dock-btn-primary"
              onClick={() => setSendMenu((v) => !v)}
              aria-expanded={sendMenu}
              title="Send the selected cards to an agent"
            >
              <IconSend />
              <span className="dock-btn-label">Send</span>
            </button>
            {sendMenu && (
              <div className="send-menu" role="menu">
                {sessions.length === 0 && <div className="send-empty">No agents running</div>}
                {sessions.map((a) => (
                  <div key={a.sessionId} className="send-row" role="menuitem" onClick={() => sendToAgent(a.sessionId)}>
                    <Dot status={a.status} />
                    <span>{a.label || a.sessionId.slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="dock-btn dock-btn-danger" onClick={deleteSelected} title="Delete selected cards">
            <IconTrash />
          </button>
        </div>
      )}

      {/* main dock — bottom-center floating pill */}
      <div className="board-dock" role="toolbar" aria-label="Board tools">
        <div className="dock-group">
          {mode === "canvas" && (
            <button className="dock-btn labeled" onClick={addNote} title="Add a note card">
              <IconNote />
              <span className="dock-btn-label">Note</span>
            </button>
          )}
          <button className="dock-btn" onClick={() => post({ type: "newAgent" })} title="Spawn a new agent">
            <IconAgent />
          </button>
          <button
            className={"dock-btn labeled" + (mode === "teams" ? " active" : "")}
            onClick={() => setMode((mm) => (mm === "teams" ? "canvas" : "teams"))}
            title={mode === "teams" ? "Back to the canvas" : "Open the Teams cockpit"}
            aria-pressed={mode === "teams"}
          >
            <IconTeam />
            <span className="dock-btn-label">Teams</span>
            {teams?.present && mode !== "teams" && (
              <span
                className="dock-dot"
                title={
                  teams.teams.length > 1
                    ? `${teams.teams.length} active teams`
                    : `Active team: ${teams.teams[0]?.members.length ?? 0} teammate${
                        (teams.teams[0]?.members.length ?? 0) === 1 ? "" : "s"
                      }`
                }
              />
            )}
          </button>
          {mode === "canvas" && (
            <button className="dock-btn" onClick={resetView} title="Reset the view">
              <IconReset />
            </button>
          )}
        </div>
        <span className="dock-div" />
        <div className="dock-group">
          {(recency.showOlder || recency.hiddenCount > 0) && (
            <button
              className={"dock-btn" + (recency.showOlder ? " active" : "")}
              onClick={() => post({ type: "toggleOlder" })}
              title={
                recency.showOlder
                  ? "Showing all agents — click to hide older idle ones"
                  : `Show ${recency.hiddenCount} older idle agent${recency.hiddenCount === 1 ? "" : "s"}`
              }
            >
              <IconHistory />
            </button>
          )}
          <button className="dock-btn" onClick={() => setShowGuide(true)} title="Show the Pinboard guide">
            <IconHelp />
          </button>
        </div>
      </div>

      <Canvas
        agents={allAgents}
        cards={doc.cards}
        arrows={doc.arrows}
        tethers={tethers}
        camera={camera}
        selectedIds={selectedIds}
        editingId={editingId}
        canSend={selectedIds.length > 0}
        onCamera={setCamera}
        onViewport={(s) => (viewportSize.current = s)}
        onMoveCard={moveCard}
        onMoveAgent={moveAgent}
        onSelectCard={selectCard}
        onClearSelection={clearSelection}
        onFocusAgent={(id) => post({ type: "focusAgent", sessionId: id })}
        onPinDiff={(id) => post({ type: "pinDiff", sessionId: id })}
        onPinOutput={(id) => post({ type: "pinOutput", sessionId: id })}
        onOpenDiff={(id) => post({ type: "openDiff", sessionId: id })}
        onSendHere={sendToAgent}
        onToggleSubs={toggleSubs}
        onStartEdit={setEditingId}
        onEditBody={editBody}
        onArrowLabel={setArrowLabel}
      />

      {mode === "teams" && (
        <div className="cockpit-overlay">
          <TeamsCockpit
            snapshot={teams}
            onFocusAgent={(id) => post({ type: "focusAgent", sessionId: id })}
          />
        </div>
      )}

      {empty && !showGuide && mode !== "teams" && (
        <div className="board-empty">
          <div className="board-empty-card">
            <h3>Your agents, on one canvas</h3>
            <p className="empty-lead">
              Watch every Claude Code agent as a live card. Pin the diffs and outputs worth keeping, jot
              notes, link related work with arrows, then hand a selection back to an agent — which can post
              results right back here.
            </p>
            <div className="board-empty-actions">
              <button className="primary" onClick={() => setShowGuide(true)}>
                Take the 30-second tour
              </button>
              <button onClick={addNote}>Add a note</button>
              <button onClick={() => post({ type: "newAgent" })}>Spawn an agent</button>
            </div>
          </div>
        </div>
      )}

      {!empty && !showGuide && mode === "canvas" && !pinHintSeen && doc.cards.length === 0 && (
        <div className="board-hint" role="status">
          <span>
            Hover an agent card and choose <b>Pin diff</b> to freeze its work here.
          </span>
          <button
            className="board-hint-x"
            onClick={() => {
              setPinHintSeen(true);
              vscode.setState({ ...(vscode.getState<object>() || {}), pinHintSeen: true });
            }}
          >
            Got it
          </button>
        </div>
      )}

      {showGuide && (
        <Onboarding
          boardDir={config.boardDir}
          hooksReady={config.hooksReady}
          onClose={closeGuide}
          onDismiss={dismissGuide}
        />
      )}
    </div>
  );
}
