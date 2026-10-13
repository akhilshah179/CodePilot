import React from 'react';
import { ConfidenceLevel } from '../../types';
import { ShieldCheck, ShieldAlert, HelpCircle, AlertCircle } from 'lucide-react';

interface EvidenceBadgeProps {
  confidence: ConfidenceLevel;
  showIcon?: boolean;
  size?: 'sm' | 'md';
  onClick?: () => void;
}

export const EvidenceBadge: React.FC<EvidenceBadgeProps> = ({
  confidence,
  showIcon = true,
  size = 'md',
  onClick,
}) => {
  const getStyles = () => {
    switch (confidence) {
      case 'CONFIRMED':
        return {
          bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
          icon: ShieldCheck,
          label: 'Confirmed',
          tooltip: 'Directly observed in repository manifest or code calls',
        };
      case 'STRONG_INFERENCE':
        return {
          bg: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
          icon: ShieldAlert,
          label: 'Strong Inference',
          tooltip: 'Supported by multiple code calls, imports, or config patterns',
        };
      case 'POSSIBLE':
        return {
          bg: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          icon: AlertCircle,
          label: 'Possible',
          tooltip: 'Plausible pattern but limited direct evidence',
        };
      case 'UNKNOWN':
      default:
        return {
          bg: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
          icon: HelpCircle,
          label: 'Unknown',
          tooltip: 'Insufficient repository information',
        };
    }
  };

  const { bg, icon: Icon, label, tooltip } = getStyles();
  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5 gap-1' : 'text-xs px-2.5 py-1 gap-1.5 font-medium';

  return (
    <span
      onClick={onClick}
      title={tooltip}
      className={`inline-flex items-center rounded-full border ${bg} ${sizeClasses} ${
        onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''
      }`}
    >
      {showIcon && <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />}
      <span>{label}</span>
    </span>
  );
};
