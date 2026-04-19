import { useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { Canvas } from '../components/Canvas';
import { Toolbar } from '../components/Toolbar';
import { useBoard } from '../hooks/useBoard';
import { getUserId } from '../utils/strokeUtils';
import { DEFAULT_COLOR } from '../constants';

export function Board() {
  const { boardId } = useParams<{ boardId: string }>();
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const userId = getUserId();

  if (!boardId) {
    return <Navigate to="/" replace />;
  }

  const { strokes, status, addStroke, undoLastStroke, redoLastStroke, canUndo, canRedo } = useBoard({ boardId, userId });

  return (
    <div style={{ padding: 16, maxWidth: 1920, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Board: {boardId}</h2>
      </div>
      <Toolbar
        activeColor={color}
        onColorChange={setColor}
        connectionStatus={status}
        onUndo={undoLastStroke}
        onRedo={redoLastStroke}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <Canvas
        boardId={boardId}
        userId={userId}
        color={color}
        strokes={strokes}
        onStrokeComplete={addStroke}
      />
    </div>
  );
}
