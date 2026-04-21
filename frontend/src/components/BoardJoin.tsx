import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { generateBoardCode } from '../utils/strokeUtils';

export function BoardJoin() {
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  const handleCreate = () => {
    const boardCode = generateBoardCode();
    navigate(`/board/${boardCode}`);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toLowerCase();
    if (trimmed.length > 0) {
      navigate(`/board/${trimmed}`);
    }
  };

  const handleDashboard = () => {
    navigate('/dashboard');
  };

  return (
    <div data-testid="board-join" style={{ maxWidth: 400, margin: '80px auto', textAlign: 'center' }}>
      <h1>Mini-RAFT Drawing Board</h1>
      <button data-testid="create-board" onClick={handleCreate} style={{ fontSize: 18, padding: '12px 24px', marginBottom: 32 }}>
        Create Board
      </button>
      <div style={{ marginBottom: 20 }}>
        <button data-testid="open-dashboard" onClick={handleDashboard} style={{ fontSize: 14, padding: '8px 14px' }}>
          Open RAFT Dashboard
        </button>
      </div>
      <form onSubmit={handleJoin}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            data-testid="board-code-input"
            type="text"
            placeholder="Enter board code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ flex: 1, fontSize: 16, padding: '8px 12px' }}
          />
          <button data-testid="join-board" type="submit" style={{ fontSize: 16, padding: '8px 16px' }}>
            Join
          </button>
        </div>
      </form>
    </div>
  );
}
