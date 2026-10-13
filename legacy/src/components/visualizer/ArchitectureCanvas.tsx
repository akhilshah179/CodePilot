import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Project, GraphNode, GraphEdge, NodeLayer, ConfidenceLevel, RequestFlow } from '../../types';
import { EvidenceBadge } from './EvidenceBadge';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Filter,
  Search,
  Layers,
  Database,
  Server,
  Cloud,
  Globe,
  Lock,
  Cpu,
  Boxes,
  Zap,
} from 'lucide-react';

interface ArchitectureCanvasProps {
  project: Project;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  activeFlow?: RequestFlow | null;
  currentStepIndex?: number;
}

export const ArchitectureCanvas: React.FC<ArchitectureCanvasProps> = ({
  project,
  selectedNodeId,
  onSelectNode,
  activeFlow,
  currentStepIndex = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number>(0.9);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 60, y: 40 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedLayer, setSelectedLayer] = useState<string>('all');
  const [selectedConfidence, setSelectedConfidence] = useState<string>('all');

  // Active step in flow
  const currentStepNodeId = activeFlow?.steps[currentStepIndex]?.nodeId;

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => Math.min(2.0, z + 0.15));
  const handleZoomOut = () => setZoom(z => Math.max(0.4, z - 0.15));
  const handleResetView = () => {
    setZoom(0.9);
    setPan({ x: 60, y: 40 });
  };

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === containerRef.current || (e.target as HTMLElement).tagName === 'svg') {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;
    setZoom(z => Math.min(2.0, Math.max(0.4, z * zoomFactor)));
  };

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    return project.nodes.filter(node => {
      // Search match
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesLabel = node.label.toLowerCase().includes(query);
        const matchesTech = node.technology?.toLowerCase().includes(query);
        const matchesDesc = node.description.toLowerCase().includes(query);
        if (!matchesLabel && !matchesTech && !matchesDesc) return false;
      }
      // Layer match
      if (selectedLayer !== 'all' && node.layer !== selectedLayer) return false;
      // Confidence match
      if (selectedConfidence !== 'all' && node.confidence !== selectedConfidence) return false;

      return true;
    });
  }, [project.nodes, searchQuery, selectedLayer, selectedConfidence]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map(n => n.id)), [filteredNodes]);

  // Filtered edges
  const filteredEdges = useMemo(() => {
    return project.edges.filter(edge => {
      return filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target);
    });
  }, [project.edges, filteredNodeIds]);

  // Helper for node type icon
  const getNodeIcon = (type: string) => {
    switch (type) {
      case 'frontend':
        return Globe;
      case 'gateway':
      case 'service':
        return Server;
      case 'database':
        return Database;
      case 'cache':
        return Zap;
      case 'queue':
        return Boxes;
      case 'auth':
        return Lock;
      case 'cloud':
        return Cloud;
      case 'ml':
        return Cpu;
      default:
        return Layers;
    }
  };

  // Layer column boundaries for visual lanes
  const layerLanes: { layer: NodeLayer; label: string; x: number; width: number }[] = [
    { layer: 'client', label: '1. CLIENT & SPA', x: 40, width: 220 },
    { layer: 'gateway', label: '2. API GATEWAY / PROXY', x: 290, width: 230 },
    { layer: 'service', label: '3. SERVICES & DOMAIN', x: 550, width: 250 },
    { layer: 'data', label: '4. DATA & CACHING TIER', x: 830, width: 250 },
    { layer: 'external', label: '5. EXTERNAL & CLOUD', x: 1110, width: 240 },
  ];

  return (
    <div className="relative w-full h-[650px] bg-[#080b11] rounded-2xl border border-slate-800/80 overflow-hidden select-none">
      {/* Top Toolbar Overlay */}
      <div className="absolute top-4 left-4 right-4 z-10 flex flex-wrap items-center justify-between gap-3 pointer-events-none">
        {/* Search & Filters (pointer-events-auto) */}
        <div className="flex items-center gap-2 pointer-events-auto bg-[#0e131f]/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-800 shadow-xl">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5" />
            <input
              type="text"
              placeholder="Filter nodes or tech..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="bg-slate-900 border border-slate-700/60 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 w-44 sm:w-56"
            />
          </div>

          <select
            value={selectedLayer}
            onChange={e => setSelectedLayer(e.target.value)}
            className="bg-slate-900 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-brand-500"
          >
            <option value="all">All Layers</option>
            <option value="client">Client Layer</option>
            <option value="gateway">Gateway Layer</option>
            <option value="service">Service Layer</option>
            <option value="data">Data & Cache Tier</option>
            <option value="external">External & Cloud</option>
          </select>

          <select
            value={selectedConfidence}
            onChange={e => setSelectedConfidence(e.target.value)}
            className="bg-slate-900 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-brand-500 hidden md:block"
          >
            <option value="all">All Confidence</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="STRONG_INFERENCE">Strong Inference</option>
            <option value="POSSIBLE">Possible</option>
          </select>
        </div>

        {/* Zoom & Canvas Controls */}
        <div className="flex items-center gap-1.5 pointer-events-auto bg-[#0e131f]/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-800 shadow-xl">
          <button
            onClick={handleZoomIn}
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={handleZoomOut}
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={handleResetView}
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white"
            title="Reset View"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <span className="px-2 text-[11px] font-mono text-slate-400 font-medium">
            {Math.round(zoom * 100)}%
          </span>
        </div>
      </div>

      {/* Main Graph Viewport */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        className={`w-full h-full bg-grid-pattern cursor-${isDragging ? 'grabbing' : 'grab'} overflow-hidden relative`}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: '1400px',
            height: '750px',
          }}
          className="relative transition-transform duration-75"
        >
          {/* Layer Lane Columns Backdrop */}
          {layerLanes.map(lane => (
            <div
              key={lane.layer}
              style={{ left: `${lane.x}px`, width: `${lane.width}px` }}
              className="absolute top-10 bottom-10 rounded-2xl bg-slate-900/20 border border-slate-800/40 pointer-events-none flex flex-col justify-between p-3"
            >
              <div className="text-[10px] font-mono font-bold tracking-wider text-slate-600 uppercase border-b border-slate-800/50 pb-2">
                {lane.label}
              </div>
              <div className="text-[9px] font-mono text-slate-700 text-right">
                {project.nodes.filter(n => n.layer === lane.layer).length} nodes
              </div>
            </div>
          ))}

          {/* SVG Canvas for Relationship Edges & Particles */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
            <defs>
              <linearGradient id="edgeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#0e8ce9" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#00f5ff" stopOpacity="0.7" />
              </linearGradient>

              {/* Marker Arrow */}
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon points="0 0, 10 3.5, 0 7" fill="#38a9f8" />
              </marker>

              <marker
                id="arrowhead-active"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon points="0 0, 10 3.5, 0 7" fill="#00f5ff" />
              </marker>

              {/* Glowing Particle Filter */}
              <filter id="glow-filter" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Render Edges */}
            {filteredEdges.map(edge => {
              const sourceNode = project.nodes.find(n => n.id === edge.source);
              const targetNode = project.nodes.find(n => n.id === edge.target);
              if (!sourceNode || !targetNode) return null;

              const isFlowEdge = activeFlow?.edgeSequence.includes(edge.id);

              // Calculate source & target card attachment points
              // Node cards are ~200px wide, ~110px high
              const sx = sourceNode.x + 200;
              const sy = sourceNode.y + 45;
              const tx = targetNode.x;
              const ty = targetNode.y + 45;

              // Cubic bezier control points for elegant routing
              const dx = Math.abs(tx - sx) * 0.5;
              const pathData = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;

              return (
                <g key={edge.id} className="transition-all duration-300">
                  {/* Background Path Line */}
                  <path
                    d={pathData}
                    fill="none"
                    stroke={isFlowEdge ? '#00f5ff' : '#1e293b'}
                    strokeWidth={isFlowEdge ? 2.5 : 1.5}
                    strokeDasharray={edge.relation === 'READS_FROM' ? '4,4' : undefined}
                    markerEnd={isFlowEdge ? 'url(#arrowhead-active)' : 'url(#arrowhead)'}
                    className={isFlowEdge ? 'drop-shadow-[0_0_8px_rgba(0,245,255,0.6)]' : ''}
                  />

                  {/* Animated Particle Flow */}
                  {(isFlowEdge || edge.animated) && (
                    <circle r={isFlowEdge ? 4.5 : 3} fill={isFlowEdge ? '#00f5ff' : '#38a9f8'} filter="url(#glow-filter)">
                      <animateMotion
                        path={pathData}
                        dur={isFlowEdge ? '2s' : '3.5s'}
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}

                  {/* Edge Label Badge */}
                  <text
                    x={(sx + tx) / 2}
                    y={(sy + ty) / 2 - 8}
                    textAnchor="middle"
                    fill={isFlowEdge ? '#00f5ff' : '#64748b'}
                    fontSize="9.5"
                    fontFamily="monospace"
                    className="font-medium bg-slate-950 px-1"
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Render Node Cards */}
          {filteredNodes.map(node => {
            const isSelected = selectedNodeId === node.id;
            const isCurrentInFlow = currentStepNodeId === node.id;
            const Icon = getNodeIcon(node.type);

            return (
              <div
                key={node.id}
                onClick={e => {
                  e.stopPropagation();
                  onSelectNode(node.id);
                }}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: '210px',
                  zIndex: isSelected || isCurrentInFlow ? 20 : 10,
                }}
                className={`absolute p-3 rounded-xl cursor-pointer transition-all duration-200 ${
                  isCurrentInFlow
                    ? 'bg-slate-900 border-2 border-cyan-400 ring-4 ring-cyan-400/30 shadow-[0_0_24px_rgba(0,245,255,0.4)] scale-105'
                    : isSelected
                    ? 'bg-[#111726] border-2 border-brand-500 shadow-[0_0_20px_rgba(14,140,233,0.35)] scale-102'
                    : 'bg-[#0e131f]/95 hover:bg-[#131b2e] border border-slate-800 hover:border-slate-700 shadow-lg'
                }`}
              >
                {/* Header with Type Icon & Confidence */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <div
                      className={`w-6 h-6 rounded-md flex items-center justify-center ${
                        node.type === 'database' || node.type === 'cache'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                          : node.type === 'frontend'
                          ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                          : 'bg-brand-500/10 text-brand-400 border border-brand-500/30'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider font-semibold">
                      {node.type}
                    </span>
                  </div>
                  <EvidenceBadge confidence={node.confidence} size="sm" showIcon={false} />
                </div>

                {/* Node Title */}
                <div className="font-semibold text-white text-xs tracking-tight truncate" title={node.label}>
                  {node.label}
                </div>

                {/* Tech Pill */}
                {node.technology && (
                  <div className="text-[10.5px] font-mono text-cyan-400 truncate mt-0.5">
                    {node.technology}
                  </div>
                )}

                {/* Metrics / Connection stats */}
                <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[9.5px] text-slate-400 font-mono">
                  <span>{node.metrics?.complexity || 'Med'} Comp</span>
                  <span>{node.metrics?.linesOfCode ? `${node.metrics.linesOfCode} LOC` : 'System'}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Status Ribbon */}
      <div className="absolute bottom-3 left-4 right-4 z-10 flex items-center justify-between text-[11px] font-mono text-slate-400 pointer-events-none">
        <div className="bg-[#0e131f]/90 backdrop-blur-md px-3 py-1 rounded-lg border border-slate-800 shadow-md">
          {filteredNodes.length} nodes • {filteredEdges.length} relationship edges • {project.technologies.length} verified technologies
        </div>
        {activeFlow && (
          <div className="bg-[#0e131f]/90 backdrop-blur-md px-3 py-1 rounded-lg border border-cyan-500/30 text-cyan-300 shadow-md flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
            <span>Active Flow: {activeFlow.name}</span>
          </div>
        )}
      </div>
    </div>
  );
};
