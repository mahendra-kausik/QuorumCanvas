import { COLORS } from '../constants';
import type { ConnectionStatus } from '../hooks/useWebSocket';

interface ToolbarProps {
  activeColor: string;
  onColorChange: (color: string) => void;
  connectionStatus: ConnectionStatus;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function Toolbar({ activeColor, onColorChange, connectionStatus, onUndo, onRedo, canUndo, canRedo }: ToolbarProps) {
  return (
    <div data-testid="toolbar" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
      {COLORS.map((color) => (
        <button
          key={color}
          data-testid={`color-${color}`}
          onClick={() => onColorChange(color)}
          aria-label={`Select color ${color}`}
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            backgroundColor: color,
            border: activeColor === color ? '3px solid #333' : '3px solid transparent',
            cursor: 'pointer',
            outline: activeColor === color ? '2px solid #666' : 'none',
          }}
        />
      ))}
      <button
        data-testid="undo-button"
        onClick={onUndo}
        disabled={!canUndo}
        style={{
          marginLeft: 8,
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid #bbb',
          background: canUndo ? '#f5f5f5' : '#eee',
          color: '#333',
          cursor: canUndo ? 'pointer' : 'not-allowed',
        }}
      >
        Undo
      </button>
      <button
        data-testid="redo-button"
        onClick={onRedo}
        disabled={!canRedo}
        style={{
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid #bbb',
          background: canRedo ? '#f5f5f5' : '#eee',
          color: '#333',
          cursor: canRedo ? 'pointer' : 'not-allowed',
        }}
      >
        Redo
      </button>
      <span
        data-testid="connection-status"
        style={{
          marginLeft: 'auto',
          fontSize: '14px',
          color:
            connectionStatus === 'connected'
              ? '#2ECC71'
              : connectionStatus === 'connecting'
                ? '#F39C12'
                : '#E74C3C',
        }}
      >
        {connectionStatus === 'connected'
          ? 'Connected'
          : connectionStatus === 'connecting'
            ? 'Connecting...'
            : 'Disconnected'}
      </span>
    </div>
  );
}
