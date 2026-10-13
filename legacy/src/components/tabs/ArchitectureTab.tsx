import React, { useState } from 'react';
import { Project, RequestFlow } from '../../types';
import { ArchitectureCanvas } from '../visualizer/ArchitectureCanvas';
import { MotionArchitecture } from '../visualizer/MotionArchitecture';
import { NodeInspector } from '../visualizer/NodeInspector';

interface ArchitectureTabProps {
  project: Project;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const ArchitectureTab: React.FC<ArchitectureTabProps> = ({
  project,
  selectedNodeId,
  onSelectNode,
  onNavigateTab,
}) => {
  const [activeFlow, setActiveFlow] = useState<RequestFlow | null>(project.flows[0] || null);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const selectedNode = project.nodes.find(n => n.id === selectedNodeId) || null;

  return (
    <div className="space-y-6 pb-12">
      {/* Motion Architecture Flow Runner Panel */}
      <MotionArchitecture
        project={project}
        activeFlow={activeFlow}
        onSelectFlow={flow => {
          setActiveFlow(flow);
          setCurrentStepIndex(0);
        }}
        currentStepIndex={currentStepIndex}
        onStepChange={setCurrentStepIndex}
        isPlaying={isPlaying}
        onTogglePlay={() => setIsPlaying(!isPlaying)}
      />

      {/* Main Architecture Visualizer Container with Node Inspector Side Drawer */}
      <div className="flex rounded-2xl overflow-hidden border border-slate-800 shadow-2xl bg-[#080b11]">
        <div className="flex-1 min-w-0">
          <ArchitectureCanvas
            project={project}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
            activeFlow={activeFlow}
            currentStepIndex={currentStepIndex}
          />
        </div>

        {/* Node Inspector Drawer */}
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            project={project}
            onClose={() => onSelectNode(null)}
            onSelectNode={onSelectNode}
            onNavigateTab={onNavigateTab}
          />
        )}
      </div>
    </div>
  );
};
