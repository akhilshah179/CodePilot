import {
  AlertOctagon,
  ArrowRight,
  CheckCircle2,
  Clock,
  Compass,
  CornerDownRight,
  Database,
  ExternalLink,
  GitBranch,
  HelpCircle,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Sparkles,
  StopCircle,
  Terminal,
  Zap,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FlowEdge,
  FlowNode,
  FlowV4,
  FlowchartLane,
} from '../../lib/api.ts';

interface FlowchartCanvasProps {
  flow: FlowV4;
  selectedNodeId?: string;
  onSelectNode: (node: FlowNode | null) => void;
  onJumpToFlow?: (flowName: string) => void;
}

interface LayoutNode {
  node: FlowNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutEdge {
  edge: FlowEdge;
  points: { x: number; y: number }[];
  labelPos: { x: number; y: number };
}

const LANES: { id: FlowchartLane; label: string; color: string }[] = [
  { id: 'user', label: 'User Action', color: '#10b981' },
  { id: 'frontend', label: 'Frontend Client', color: '#0ea5e9' },
  { id: 'backend', label: 'Backend Server', color: '#6366f1' },
  { id: 'data', label: 'Data Store', color: '#14b8a6' },
  { id: 'external', label: 'External Service', color: '#a855f7' },
];

const LANE_ORDER: Record<FlowchartLane, number> = {
  user: 0,
  frontend: 1,
  backend: 2,
  data: 3,
  external: 4,
};

export function FlowchartCanvas({
  flow,
  selectedNodeId,
  onSelectNode,
  onJumpToFlow,
}: FlowchartCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Canvas Viewport transform
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showSwimlanes, setShowSwimlanes] = useState(false);

  // Playback Simulation State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2>(1);
  const [activeTokenNodeId, setActiveTokenNodeId] = useState<string | null>(null);
  const [visitedNodeIds, setVisitedNodeIds] = useState<Set<string>>(new Set());
  const [visitedEdgeIds, setVisitedEdgeIds] = useState<Set<string>>(new Set());
  const [pendingDecision, setPendingDecision] = useState<{
    node: FlowNode;
    outEdges: FlowEdge[];
  } | null>(null);

  // Compute Layout (orthogonal DAG)
  const { layoutNodes, layoutEdges, canvasBounds } = useMemo(() => {
    const nodeMap = new Map<string, FlowNode>(flow.nodes.map((n) => [n.id, n]));
    const outEdgesMap = new Map<string, FlowEdge[]>();
    const inEdgesMap = new Map<string, FlowEdge[]>();

    flow.edges.forEach((e) => {
      if (!outEdgesMap.has(e.source)) outEdgesMap.set(e.source, []);
      outEdgesMap.get(e.source)!.push(e);
      if (!inEdgesMap.has(e.target)) inEdgesMap.set(e.target, []);
      inEdgesMap.get(e.target)!.push(e);
    });

    // Compute ranks via BFS from trigger
    const ranks = new Map<string, number>();
    const queue: string[] = [flow.triggerNodeId || flow.nodes[0]?.id || ''];
    if (queue[0]) ranks.set(queue[0], 0);

    const visited = new Set<string>();
    while (queue.length > 0) {
      const curr = queue.shift()!;
      visited.add(curr);
      const currRank = ranks.get(curr) ?? 0;
      const nexts = outEdgesMap.get(curr) || [];
      for (const e of nexts) {
        const nextId = e.target;
        const existingRank = ranks.get(nextId) ?? 0;
        ranks.set(nextId, Math.max(existingRank, currRank + 1));
        if (!visited.has(nextId)) queue.push(nextId);
      }
    }

    // Default missing ranks
    flow.nodes.forEach((n, idx) => {
      if (!ranks.has(n.id)) ranks.set(n.id, idx);
    });

    // Coordinate mapping
    const NODE_WIDTH = 220;
    const NODE_HEIGHT = 80;
    const X_GAP = 140;
    const Y_GAP = 110;
    const LANE_HEIGHT = 160;

    const rankGroups = new Map<number, FlowNode[]>();
    flow.nodes.forEach((n) => {
      const r = ranks.get(n.id) ?? 0;
      if (!rankGroups.has(r)) rankGroups.set(r, []);
      rankGroups.get(r)!.push(n);
    });

    const calculatedNodes: LayoutNode[] = [];
    const positions = new Map<string, { x: number; y: number; w: number; h: number }>();

    flow.nodes.forEach((n) => {
      const rank = ranks.get(n.id) ?? 0;
      const group = rankGroups.get(rank) || [n];
      const indexInRank = group.findIndex((item) => item.id === n.id);

      const x = 50 + rank * (NODE_WIDTH + X_GAP);
      let y = 50;

      if (showSwimlanes) {
        const laneIdx = LANE_ORDER[n.lane || 'backend'] ?? 2;
        y = 40 + laneIdx * LANE_HEIGHT + (indexInRank * 45);
      } else {
        const totalHeight = group.length * (NODE_HEIGHT + Y_GAP);
        const startY = 160 - totalHeight / 2;
        y = Math.max(40, startY + indexInRank * (NODE_HEIGHT + Y_GAP));
      }

      const w = n.type === 'decision' ? 140 : n.type === 'trigger' || n.type === 'end' ? 200 : NODE_WIDTH;
      const h = n.type === 'decision' ? 140 : NODE_HEIGHT;

      calculatedNodes.push({ node: n, x, y, width: w, height: h });
      positions.set(n.id, { x, y, w, h });
    });

    // Orthogonal edge routing
    const calculatedEdges: LayoutEdge[] = [];
    flow.edges.forEach((edge) => {
      const src = positions.get(edge.source);
      const tgt = positions.get(edge.target);
      if (!src || !tgt) return;

      const x1 = src.x + src.w;
      const y1 = src.y + src.h / 2;
      const x2 = tgt.x;
      const y2 = tgt.y + tgt.h / 2;

      let points: { x: number; y: number }[] = [];
      let labelPos = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };

      if (Math.abs(y1 - y2) < 4) {
        // Direct horizontal
        points = [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ];
        labelPos = { x: (x1 + x2) / 2, y: y1 - 12 };
      } else {
        // Orthogonal 3-segment step
        const midX = x1 + (x2 - x1) / 2;
        points = [
          { x: x1, y: y1 },
          { x: midX, y: y1 },
          { x: midX, y: y2 },
          { x: x2, y: y2 },
        ];
        labelPos = { x: midX, y: (y1 + y2) / 2 - 10 };
      }

      calculatedEdges.push({ edge, points, labelPos });
    });

    let maxX = 800;
    let maxY = 500;
    calculatedNodes.forEach((n) => {
      maxX = Math.max(maxX, n.x + n.width + 120);
      maxY = Math.max(maxY, n.y + n.height + 120);
    });

    return {
      layoutNodes: calculatedNodes,
      layoutEdges: calculatedEdges,
      canvasBounds: { width: maxX, height: showSwimlanes ? LANE_HEIGHT * 5 + 80 : maxY },
    };
  }, [flow, showSwimlanes]);

  // Handle Playback Loop
  useEffect(() => {
    if (!isPlaying) return;

    if (!activeTokenNodeId) {
      const startId = flow.triggerNodeId || flow.nodes[0]?.id;
      if (startId) {
        setActiveTokenNodeId(startId);
        setVisitedNodeIds(new Set([startId]));
      }
      return;
    }

    const currNode = flow.nodes.find((n) => n.id === activeTokenNodeId);
    if (!currNode) return;

    const outEdges = flow.edges.filter((e) => e.source === activeTokenNodeId);

    // If at End node, finish simulation
    if (currNode.type === 'end' || outEdges.length === 0) {
      setIsPlaying(false);
      return;
    }

    // If at Decision Diamond, pause for user branch choice
    if (currNode.type === 'decision') {
      setPendingDecision({ node: currNode, outEdges });
      setIsPlaying(false);
      return;
    }

    // Step to next node along the first sequence/active edge
    const timer = setTimeout(() => {
      const nextEdge = outEdges[0];
      if (nextEdge) {
        setActiveTokenNodeId(nextEdge.target);
        setVisitedNodeIds((prev) => new Set([...prev, nextEdge.target]));
        setVisitedEdgeIds((prev) => new Set([...prev, nextEdge.id]));
      } else {
        setIsPlaying(false);
      }
    }, 1200 / playbackSpeed);

    return () => clearTimeout(timer);
  }, [isPlaying, activeTokenNodeId, flow, playbackSpeed]);

  const handleChooseBranch = (edge: FlowEdge) => {
    setPendingDecision(null);
    setActiveTokenNodeId(edge.target);
    setVisitedNodeIds((prev) => new Set([...prev, edge.target]));
    setVisitedEdgeIds((prev) => new Set([...prev, edge.id]));
    setIsPlaying(true);
  };

  const handleResetPlayback = () => {
    setIsPlaying(false);
    setActiveTokenNodeId(null);
    setVisitedNodeIds(new Set());
    setVisitedEdgeIds(new Set());
    setPendingDecision(null);
  };

  const handleStepPlayback = () => {
    if (!activeTokenNodeId) {
      const startId = flow.triggerNodeId || flow.nodes[0]?.id;
      if (startId) {
        setActiveTokenNodeId(startId);
        setVisitedNodeIds(new Set([startId]));
      }
      return;
    }

    const outEdges = flow.edges.filter((e) => e.source === activeTokenNodeId);
    const currNode = flow.nodes.find((n) => n.id === activeTokenNodeId);

    if (currNode?.type === 'decision') {
      setPendingDecision({ node: currNode, outEdges });
      return;
    }

    if (outEdges.length > 0) {
      const nextEdge = outEdges[0];
      setActiveTokenNodeId(nextEdge.target);
      setVisitedNodeIds((prev) => new Set([...prev, nextEdge.target]));
      setVisitedEdgeIds((prev) => new Set([...prev, nextEdge.id]));
    }
  };

  // Zoom / Pan handlers
  const handleZoom = (delta: number) => {
    setZoom((z) => Math.max(0.4, Math.min(2.0, Number((z + delta).toFixed(1)))));
  };

  const handleFitView = () => {
    setZoom(0.85);
    setPan({ x: 30, y: 30 });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === containerRef.current || (e.target as HTMLElement).tagName === 'svg') {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  return (
    <div className="flowchart-container">
      {/* Canvas Top Toolbar (Never overlaps nodes) */}
      <div className="flowchart-toolbar">
        <div className="flowchart-toolbar-group">
          <button
            type="button"
            className={`flowchart-btn ${isPlaying ? 'active' : ''}`}
            onClick={() => setIsPlaying(!isPlaying)}
            title={isPlaying ? 'Pause Playback' : 'Start Playback Token'}
          >
            {isPlaying ? <StopCircle size={14} /> : <Play size={14} />}
            <span>{isPlaying ? 'Pause' : 'Play Token'}</span>
          </button>
          <button
            type="button"
            className="flowchart-btn"
            onClick={handleStepPlayback}
            title="Step to next node"
          >
            <ArrowRight size={14} />
            <span>Step</span>
          </button>
          <button
            type="button"
            className="flowchart-btn"
            onClick={handleResetPlayback}
            title="Reset playback"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className="flowchart-btn"
            onClick={() => setPlaybackSpeed(playbackSpeed === 1 ? 2 : 1)}
            title="Toggle playback speed"
          >
            <Zap size={14} />
            <span>{playbackSpeed}x</span>
          </button>
        </div>

        <div className="flowchart-toolbar-group">
          <button
            type="button"
            className={`flowchart-btn ${showSwimlanes ? 'active' : ''}`}
            onClick={() => setShowSwimlanes(!showSwimlanes)}
            title="Toggle Swimlanes (User / Frontend / Backend / Data / External)"
          >
            <Compass size={14} />
            <span>Swimlanes</span>
          </button>
          <div className="flowchart-divider" />
          <button
            type="button"
            className="flowchart-btn"
            onClick={() => handleZoom(0.1)}
            title="Zoom in"
          >
            <Plus size={14} />
          </button>
          <span className="flowchart-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="flowchart-btn"
            onClick={() => handleZoom(-0.1)}
            title="Zoom out"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="flowchart-btn"
            onClick={handleFitView}
            title="Fit to view"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* Main Flowchart Canvas Area */}
      <div
        ref={containerRef}
        className="flowchart-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'default' }}
      >
        <div
          className="flowchart-transform-plane"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: `${canvasBounds.width}px`,
            height: `${canvasBounds.height}px`,
          }}
        >
          {/* Optional Swimlanes Backgrounds */}
          {showSwimlanes && (
            <div className="flowchart-swimlanes-grid">
              {LANES.map((lane, idx) => (
                <div
                  key={lane.id}
                  className="flowchart-swimlane-row"
                  style={{ top: `${idx * 160 + 20}px`, height: '160px' }}
                >
                  <div className="flowchart-swimlane-header" style={{ color: lane.color }}>
                    <span className="flowchart-swimlane-badge" style={{ backgroundColor: lane.color }} />
                    {lane.label}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* SVG Connector Edges */}
          <svg
            className="flowchart-edges-svg"
            width={canvasBounds.width}
            height={canvasBounds.height}
          >
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--text-3, #71717a)" />
              </marker>
              <marker
                id="flow-arrow-active"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="#10b981" />
              </marker>
              <marker
                id="flow-arrow-true"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="#10b981" />
              </marker>
              <marker
                id="flow-arrow-false"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="#ef4444" />
              </marker>
            </defs>

            {layoutEdges.map(({ edge, points, labelPos }) => {
              const pathD = points
                .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
                .join(' ');
              const isVisited = visitedEdgeIds.has(edge.id);
              const isTrue = edge.kind === 'true' || edge.label?.startsWith('TRUE');
              const isFalse = edge.kind === 'false' || edge.label?.startsWith('FALSE');

              let strokeColor = 'var(--line-strong, #3f3f46)';
              let markerId = 'flow-arrow';

              if (isVisited) {
                strokeColor = '#10b981';
                markerId = 'flow-arrow-active';
              } else if (isTrue) {
                strokeColor = '#10b981';
                markerId = 'flow-arrow-true';
              } else if (isFalse) {
                strokeColor = '#f43f5e';
                markerId = 'flow-arrow-false';
              } else if (edge.kind === 'async') {
                strokeColor = '#a855f7';
              }

              return (
                <g key={edge.id} className="flowchart-edge-group">
                  <path
                    d={pathD}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isVisited ? 2.5 : 1.8}
                    strokeDasharray={edge.kind === 'async' ? '4 4' : undefined}
                    markerEnd={`url(#${markerId})`}
                    className={isVisited ? 'flowchart-edge-visited' : ''}
                  />

                  {/* Edge Payload Badge & Timers */}
                  {(edge.label || edge.timer) && (
                    <foreignObject
                      x={labelPos.x - 70}
                      y={labelPos.y - 14}
                      width={140}
                      height={28}
                      className="flowchart-edge-label-container"
                    >
                      <div className="flowchart-edge-label-wrapper">
                        {edge.label && (
                          <span
                            className={`flowchart-edge-badge ${
                              isTrue ? 'true' : isFalse ? 'false' : isVisited ? 'active' : ''
                            }`}
                          >
                            {edge.label}
                          </span>
                        )}
                        {edge.timer && (
                          <span className="flowchart-edge-timer">
                            <Clock size={9} />
                            {edge.timer}
                          </span>
                        )}
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Render Flowchart Nodes */}
          {layoutNodes.map(({ node, x, y, width, height }) => {
            const isSelected = selectedNodeId === node.id;
            const isTokenHere = activeTokenNodeId === node.id;
            const isVisited = visitedNodeIds.has(node.id);

            return (
              <div
                key={node.id}
                id={`node-${node.id}`}
                className={`flowchart-node-wrapper type-${node.type} ${
                  isSelected ? 'selected' : ''
                } ${isVisited ? 'visited' : ''} ${isTokenHere ? 'token-active' : ''}`}
                style={{
                  left: `${x}px`,
                  top: `${y}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNode(node);
                }}
                title={node.tooltip}
              >
                {/* Visual Node Content per type */}
                {renderNodeShape(node, isTokenHere, onJumpToFlow)}

                {/* Animated Traveling Token Indicator */}
                {isTokenHere && (
                  <div className="flowchart-playback-token">
                    <span className="flowchart-token-pulse" />
                    <Sparkles size={13} className="flowchart-token-icon" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Minimap in Bottom-Right Corner */}
        <div className="flowchart-minimap">
          <div className="flowchart-minimap-header">Flowchart Map</div>
          <svg className="flowchart-minimap-svg" viewBox={`0 0 ${canvasBounds.width} ${canvasBounds.height}`}>
            {layoutNodes.map((n) => (
              <rect
                key={n.node.id}
                x={n.x}
                y={n.y}
                width={n.width}
                height={n.height}
                fill={
                  n.node.id === selectedNodeId
                    ? 'var(--accent, #f59e0b)'
                    : n.node.type === 'decision'
                    ? '#fbbf24'
                    : '#475569'
                }
                rx={n.node.type === 'trigger' || n.node.type === 'end' ? 12 : 4}
              />
            ))}
          </svg>
        </div>

        {/* Interactive Decision Popup during Playback */}
        {pendingDecision && (
          <div className="flowchart-decision-modal">
            <div className="flowchart-decision-header">
              <GitBranch size={16} />
              <span>Conditional Decision Point</span>
            </div>
            <p className="flowchart-decision-prompt">
              Code expression: <code>{pendingDecision.node.decisionExpr || pendingDecision.node.label}</code>
            </p>
            <p className="flowchart-decision-subtext">Choose an execution branch to proceed:</p>
            <div className="flowchart-decision-choices">
              {pendingDecision.outEdges.map((edge) => {
                const isTrue = edge.kind === 'true' || edge.label?.startsWith('TRUE');
                const isFalse = edge.kind === 'false' || edge.label?.startsWith('FALSE');
                return (
                  <button
                    key={edge.id}
                    type="button"
                    className={`flowchart-branch-btn ${isTrue ? 'true' : isFalse ? 'false' : ''}`}
                    onClick={() => handleChooseBranch(edge)}
                  >
                    {edge.label || `Branch: ${edge.target}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function renderNodeShape(
  node: FlowNode,
  isTokenActive: boolean,
  onJumpToFlow?: (flowName: string) => void,
) {
  switch (node.type) {
    case 'trigger':
      return (
        <div className="flowchart-node-pill trigger">
          <div className="flowchart-node-icon trigger">
            <Play size={14} />
          </div>
          <div className="flowchart-node-content">
            <span className="flowchart-node-tag">Trigger</span>
            <span className="flowchart-node-title">{node.label}</span>
          </div>
        </div>
      );

    case 'ui_step':
      return (
        <div className="flowchart-node-card ui-step">
          <div className="flowchart-node-header">
            <MousePointer size={13} className="flowchart-node-subicon" />
            <span className="flowchart-node-tag">UI Step</span>
            {node.tools.length > 0 && <span className="flowchart-tool-chip">{node.tools[0]}</span>}
          </div>
          <div className="flowchart-node-title">{node.label}</div>
          <div className="flowchart-node-cite">{node.file}:{node.line}</div>
        </div>
      );

    case 'request':
      return (
        <div className="flowchart-node-card request">
          <div className="flowchart-node-header">
            <ArrowRight size={13} className="flowchart-node-subicon" />
            <span className="flowchart-node-tag">HTTP Request</span>
            {node.tools.length > 0 && <span className="flowchart-tool-chip">{node.tools[0]}</span>}
          </div>
          <div className="flowchart-node-title">{node.label}</div>
          <div className="flowchart-node-cite">{node.file}:{node.line}</div>
        </div>
      );

    case 'server_step':
      return (
        <div className="flowchart-node-card server-step">
          <div className="flowchart-node-header">
            <Server size={13} className="flowchart-node-subicon" />
            <span className="flowchart-node-tag">Server Step</span>
            {node.tools.length > 0 && <span className="flowchart-tool-chip">{node.tools[0]}</span>}
          </div>
          <div className="flowchart-node-title">{node.label}</div>
          <div className="flowchart-node-cite">{node.file}:{node.line}</div>
        </div>
      );

    case 'decision':
      return (
        <div className="flowchart-node-diamond-container">
          <div className="flowchart-diamond-shape">
            <div className="flowchart-diamond-inner">
              <HelpCircle size={15} className="flowchart-diamond-icon" />
              <span className="flowchart-diamond-title">{node.label}</span>
            </div>
          </div>
          <div className="flowchart-diamond-meta">
            {node.decisionExpr && <code>{node.decisionExpr}</code>}
          </div>
          {/* Branch Exit Points */}
          <div className="flowchart-branch-port true" title="TRUE branch exit">T</div>
          <div className="flowchart-branch-port false" title="FALSE branch exit">F</div>
        </div>
      );

    case 'data_store':
      return (
        <div className="flowchart-node-cylinder">
          <div className="cylinder-top" />
          <div className="cylinder-body">
            <div className="flowchart-node-header">
              <Database size={13} className="flowchart-node-subicon" />
              <span className="flowchart-node-tag">
                {node.dataOperation?.toUpperCase() || 'DATA STORE'}
              </span>
            </div>
            <div className="flowchart-node-title">{node.label}</div>
            <div className="flowchart-node-cite">{node.file}:{node.line}</div>
          </div>
        </div>
      );

    case 'external_service':
      return (
        <div className="flowchart-node-hexagon">
          <div className="hexagon-inner">
            <div className="flowchart-node-header">
              <ExternalLink size={13} className="flowchart-node-subicon" />
              <span className="flowchart-node-tag">External API</span>
            </div>
            <div className="flowchart-node-title">{node.label}</div>
            {node.tools.length > 0 && <span className="flowchart-tool-chip">{node.tools.join(', ')}</span>}
          </div>
        </div>
      );

    case 'background_job':
      return (
        <div className="flowchart-node-card background-job">
          <div className="flowchart-node-header">
            <Clock size={13} className="flowchart-node-subicon" />
            <span className="flowchart-node-tag">Async Worker</span>
            <span className="flowchart-async-badge">Non-blocking</span>
          </div>
          <div className="flowchart-node-title">{node.label}</div>
          <div className="flowchart-node-cite">{node.file}:{node.line}</div>
        </div>
      );

    case 'end':
      return (
        <div className="flowchart-node-pill end">
          <div className="flowchart-node-icon end">
            <CheckCircle2 size={14} />
          </div>
          <div className="flowchart-node-content">
            <span className="flowchart-node-tag">Outcome / End</span>
            <span className="flowchart-node-title">{node.label}</span>
          </div>
        </div>
      );

    case 'jump':
      return (
        <div
          className="flowchart-node-pill jump"
          onClick={(e) => {
            e.stopPropagation();
            if (node.jumpTargetFlow && onJumpToFlow) {
              onJumpToFlow(node.jumpTargetFlow);
            }
          }}
        >
          <div className="flowchart-node-icon jump">
            <CornerDownRight size={14} />
          </div>
          <div className="flowchart-node-content">
            <span className="flowchart-node-tag">Jump to Flow</span>
            <span className="flowchart-node-title">{node.label}</span>
          </div>
        </div>
      );

    case 'unknown':
    default:
      return (
        <div className="flowchart-node-card unknown">
          <div className="flowchart-node-header">
            <AlertOctagon size={13} className="flowchart-node-subicon red" />
            <span className="flowchart-node-tag red">Unresolved Step</span>
          </div>
          <div className="flowchart-node-title">{node.label}</div>
          <div className="flowchart-unknown-reason">{node.unknownReason || 'Call target is dynamic'}</div>
        </div>
      );
  }
}
